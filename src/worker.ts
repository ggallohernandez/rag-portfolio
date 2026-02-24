import { buildContainer } from "./bootstrap.js";

async function main() {
  const container = await buildContainer();

  container.logger.info("worker started", {
    mode: container.config.adapterMode
  });

  if (container.config.adapterMode === "real" && container.bullQueue) {
    container.bullQueue.createWorker(
      async (jobId) => {
        await container.ingestionService.processJobById(jobId);
      },
      async (jobId, error, attempts) => {
        await container.ingestionService.handlePermanentFailure(
          jobId,
          error,
          attempts,
          {
            kind: "ingestion",
            job_id: jobId
          }
        );
      }
    );
  }

  setInterval(() => {
    void container.reconciler.reconcile();
    void container.watchdog.scan();
  }, 10_000);
}

void main();
