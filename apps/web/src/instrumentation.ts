export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startVisionWsHub } = await import("./lib/ws-hub");
    startVisionWsHub();
  }
}
