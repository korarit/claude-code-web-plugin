export type Nullable<T> = T | null | undefined;

export interface Page<T> {
  items: T[];
  total: number;
}
