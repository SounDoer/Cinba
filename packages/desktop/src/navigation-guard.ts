export type NavigationGuard = {
  begin(): number;
  current(token: number): boolean;
};

export function createNavigationGuard(): NavigationGuard {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      return generation;
    },
    current: (token) => token === generation,
  };
}
