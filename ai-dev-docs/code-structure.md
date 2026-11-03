# Code Structure — DDD Modular Monolith + Shared Core

> Stack: TypeScript + Elysia (latest, Bun) + React + Tailwind v4 + shadcn/ui
> Shape: Monorepo `apps/*` + `packages/*`, ทรง Modular Monolith
> Decision: Option 1 (Shared Kernel ใน monorepo เดียวกัน)
> Date (UTC): 2026-11-03

## 1. Goal / Background

- ต้องการโครงแบบ DDD ที่แยก bounded context ชัดเจน แต่ยังมี `core` กลางที่ทุก module share ได้โดยไม่ดึง dependency ข้ามกันมั่ว
- FE (React) + BE (Elysia) อยู่ repo เดียว แชร์ type กันแบบ type-safe ผ่าน Eden Treaty โดยไม่ให้ FE ล้วง domain logic ของ BE
- เริ่มเป็น modular monolith (deploy เดียว/คู่) แต่เผื่อแยกเป็น microservices ได้ภายหลังโดยไม่รื้อโครง

## 2. Scope (In / Out)

### In
- โครง monorepo: `apps/web`, `apps/api`, `packages/core`, `packages/contracts`
- DDD layers ฝั่ง backend ต่อ bounded context: `domain / application / infrastructure / presentation`
- กฎ dependency + นาม convention + path alias (`@core/*`, `@contracts/*`)
- โครง frontend ฝั่ง React แบบ feature-based + `components/ui` (shadcn)

### Out
- ยังไม่ scaffold โค้ดจริง / ยังไม่เลือก ORM, DB, auth provider (แยก doc/issue ทีหลัง)
- ยังไม่ทำ CI/CD, Dockerfile, deploy pipeline
- ยังไม่ทำ business logic ของแต่ละ context ใดๆ

## 3. Proposed Approach — Option 1: `apps/*` + `packages/*`

- `packages/core` = Shared Kernel บริสุทธิ์ (pure TS, **zero dependency** ห้าม import Elysia/React/ORM) เก็บของที่ share ได้จริง: `Result`, `AppError`, branded `ids`, เวลา, pure utils, base types
- `packages/contracts` = สัญญา FE↔BE (Elysia models + response DTO types สำหรับ Eden Treaty) ห้ามมี business logic
- `apps/api/src/modules/<context>` = bounded context ละ 1 โฟลเดอร์ แต่ละอันมี 4 layers ครบ (ดู tree ข้อ 4)
- `apps/web` = React + Tailwind v4 + shadcn แยกตาม route/feature อ่าน `core` + `contracts` ได้เท่านั้น ห้าม deep-import `apps/api`
- ใช้ Bun workspaces เป็น monorepo (Elysia latest วิ่งบน Bun อยู่แล้ว) ยังไม่ต้อง Turborepo จนกว่าจะมีหลาย apps จริง

### Dependency rules (บังคับ)

```
core         -> ห้าม import ใครเลย (ยกเว้น stdlib)
contracts    -> import ได้แค่ core
api:domain   -> import ได้แค่ core
api:application -> domain + core (+ ports ที่ domain ประกาศ)
api:infrastructure -> domain + application(ports) + core
api:presentation (Elysia routes) -> application + contracts + core, ห้ามล้วง infrastructure ตรงๆ
web          -> core + contracts เท่านั้น, ห้าม import apps/api
```

- ข้าม bounded context คุยกันผ่าน `application` (use-case / events) เท่านั้น ห้าม `import { X } from '@/modules/other/domain/...'` ตรงๆ
- ถ้า 2 contexts ต้องใช้ของร่วมกันจริงๆ → ย้ายขึ้น `packages/core` (ถ้า generic) หรือ `packages/contracts` (ถ้าเป็น API shape)

## 4. File-level Change Plan (tree เป้าหมาย)

```
claude-web-plugin/
├── package.json                 # bun workspaces: ["apps/*", "packages/*"]
├── bun.lock
├── tsconfig.base.json           # paths: @core/*, @contracts/*
├── ai-dev-docs/
│   └── code-structure.md        # ไฟล์นี้
│
├── packages/
│   ├── core/                    # Shared Kernel (pure, zero-dep)
│   │   ├── package.json         # name: @repo/core
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts         # re-export ทั้งหมด
│   │       ├── result.ts        # Result<T, E> / ok(), err()
│   │       ├── errors.ts        # AppError, error codes
│   │       ├── ids.ts           # branded ids: UserId, etc. + nanoid/ulid helpers
│   │       ├── time.ts          # clock abstraction (testable)
│   │       ├── types.ts         # Branded, Nullable, Pagination ฯลฯ
│   │       └── utils.ts         # pure functions เท่านั้น
│   │
│   └── contracts/               # FE↔BE shared contract (Eden Treaty)
│       ├── package.json         # name: @repo/contracts
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── http.ts          # ApiResponse<T>, Page<T> envelope
│           └── <context>.ts     # เช่น user.contract.ts — Elysia t.* models + DTO types
│
├── apps/
│   ├── api/                     # Elysia backend (modular monolith)
│   │   ├── package.json         # deps: elysia, @repo/core, @repo/contracts
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts         # create App, .use(modules...), .listen()
│   │       ├── env.ts           # env parsing/validation
│   │       ├── plugins.ts       # cors, error map (AppError -> status), logger
│   │       └── modules/
│   │           └── <context>/   # ตัวอย่าง: user/
│   │               ├── domain/
│   │               │   ├── <entity>.entity.ts   # business rules + invariants
│   │               │   ├── <entity>.events.ts   # domain events
│   │               │   ├── repository.port.ts   # interface (port)
│   │               │   └── errors.ts            # context errors (extends AppError)
│   │               ├── application/
│   │               │   ├── <usecase>.usecase.ts # 1 usecase = 1 ไฟล์, in: DTO, out: Result
│   │               │   ├── ports.ts             # re-export ports ที่ usecase ต้องใช้
│   │               │   └── index.ts
│   │               ├── infrastructure/
│   │               │   ├── <entity>.repository.ts  # implements port (drizzle/prisma ภายหลัง)
│   │               │   └── mappers.ts              # db <-> entity
│   │               └── presentation/
│   │                   ├── <context>.routes.ts  # Elysia prefix + t.Model validation
│   │                   └── mappers.ts           # entity -> contract DTO
│   │
│   └── web/                     # React frontend
│       ├── package.json         # deps: react, @repo/core, @repo/contracts, eden treaty client
│       ├── tsconfig.json
│       ├── tailwind.config / app.css  # tailwind v4
│       ├── components.json      # shadcn/ui config
│       └── src/
│           ├── main.tsx / App.tsx     # router + providers + api client (treaty)
│           ├── lib/
│           │   ├── api.ts       # edenTreaty<App>() client instance
│           │   └── utils.ts     # cn() ของ shadcn
│           ├── components/
│           │   └── ui/          # shadcn generated (button, dialog, ...)
│           ├── features/
│           │   └── <feature>/   # เช่น auth/, dashboard/ — api.ts, hooks.ts, components/
│           └── routes/          # page-level (ถ้าใช้ file-router) หรือ pages/
```

### ตัวอย่างการเพิ่ม bounded context ใหม่

1. สร้าง `apps/api/src/modules/<name>/{domain,application,infrastructure,presentation}/`
2. ถ้ามี API ให้ FE เรียก → เพิ่ม `<name>.ts` ใน `packages/contracts`
3. ถ้ามี type/error/util ที่ generic จริง → เพิ่มใน `packages/core` (ห้ามเอาของเฉพาะ context ขึ้น core)
4. ต่อ route ใน `apps/api/src/index.ts` ด้วย `.use(<name>Routes)`

## 5. Test / Verification Plan

1. **Boundary check (manual/Code review):** `rg "from ['\"].*(apps/api|apps/web)" packages/core` ต้องว่างเปล่า (core ห้ามพึ่งใคร)
2. **Typecheck:** `bun run --filter '*' typecheck` (หรือ `tsc --noEmit` ทุก workspace) ต้องผ่าน
3. **Build:** `bun run build` ทั้ง `apps/web` + `apps/api` ต้องผ่าน, Eden Treaty client infer type จาก `App` ได้โดยไม่ import domain ตรง
4. **Smoke:** `bun --filter api dev` + `bun --filter web dev`, เรียก 1 endpoint ผ่าน contract client ได้
5. **(ถัดไป)** เพิ่ม `eslint-plugin-boundaries` หรือ ` knip` กัน import ผิดทิศ — แยก issue ทีหลัง

## 6. Conventions

- Bounded context ตั้งชื่อเป็นเอกพจน์ kebab-case: `user`, `billing`, `notification`
- Usecase 1 ไฟล์ต่อ 1 action: `<verb>-<object>.usecase.ts` (เช่น `create-user.usecase.ts`), return `Result<T, AppError>` เสมอ
- Route ไฟล์ละ 1 prefix: `user.routes.ts` → `.group('/users', ...)` + `t.*` validation ทุก input
- Core เพิ่มของได้ก็ต่อเมื่อใช้ ≥2 contexts และไม่มี dependency นอก stdlib — ไม่งั้นถือว่า leak ให้คงไว้ใน module เดิม
