// @ts-check
/** Shut down hosts only after all windows accepted their unload.
 * @param {Pick<import('electron').App, 'on' | 'quit'>} app
 * @param {{close: () => Promise<void>}} registry
 * @param {(error: unknown) => void} onError */
const registerHostShutdown = (app, registry, onError) => {
  let closed = false;
  /** @type {Promise<void> | null} */
  let closing = null;
  app.on('will-quit', (event) => {
    if (closed) {
      return;
    }
    event.preventDefault();
    closing ??= registry
      .close()
      .catch(onError)
      .finally(() => {
        closed = true;
        app.quit();
      });
  });
};
module.exports = { registerHostShutdown };
