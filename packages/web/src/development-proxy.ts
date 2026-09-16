export function developmentProxy(corePort: number) {
  return {
    "/api": { target: `http://127.0.0.1:${corePort}` },
    "/ws": { target: `ws://127.0.0.1:${corePort}`, ws: true },
  };
}
