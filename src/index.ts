import { buildContainer } from "./bootstrap.js";

async function main() {
  const container = await buildContainer();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);

  await container.reconciler.reconcile();

  setInterval(() => {
    void container.watchdog.scan();
  }, 30_000);

  container.app.listen(port, () => {
    container.logger.info("server started", {
      port,
      adapter_mode: container.config.adapterMode,
      base_path: container.config.basePath
    });
  });
}

void main();
