export type RunAction = (
  label: string,
  action: () => Promise<void>,
  options?: { skipRefresh?: boolean },
) => Promise<void>
