import { I18nProvider } from "./lib/i18n/index.ts";
import { ThemeProvider } from "./lib/theme/index.ts";
import WorkspacePage from "./features/chat/components/WorkspacePage.tsx";

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <WorkspacePage />
      </I18nProvider>
    </ThemeProvider>
  );
}
