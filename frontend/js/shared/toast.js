export function createToastController({ element, messageElement, closeButton, hideDelay = 180 }) {
  let hideTimerId = null;

  function cancelHideTimer() {
    if (hideTimerId) {
      window.clearTimeout(hideTimerId);
      hideTimerId = null;
    }
  }

  function hide() {
    if (!element) return;
    cancelHideTimer();
    element.classList.remove("is-visible");
    hideTimerId = window.setTimeout(() => {
      element.hidden = true;
      if (messageElement) {
        messageElement.textContent = "";
      }
      hideTimerId = null;
    }, hideDelay);
  }

  function show(message, tone = "info") {
    if (!element) return;
    cancelHideTimer();
    if (messageElement) {
      messageElement.textContent = message;
    }
    element.dataset.tone = tone;
    element.hidden = false;
    window.requestAnimationFrame(() => {
      element.classList.add("is-visible");
    });
  }

  if (closeButton) {
    closeButton.addEventListener("click", hide);
  }

  return { show, hide };
}
