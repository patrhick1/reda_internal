import type { AlertButton, AlertOptions } from 'react-native';

type AlertRequest = {
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
};

const pending: AlertRequest[] = [];
let showing = false;
let sequence = 0;

/**
 * Browser equivalent of the native alert. A modal HTML dialog keeps custom
 * button labels and all choices (including three-way sign-out) and appears
 * above React Native's picker modals. Text is never interpreted as HTML.
 */
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void {
    // Expo also imports this module while rendering static pages in Node.
    if (typeof document === 'undefined') return;
    pending.push({
      title,
      message,
      buttons: buttons?.length ? buttons : [{ text: 'OK' }],
      options,
    });
    showNext();
  },
};

function showNext(): void {
  if (showing) return;
  const request = pending.shift();
  if (!request) return;
  const options = request.options;
  showing = true;

  const dialog = document.createElement('dialog');
  const id = `reda-alert-${++sequence}`;
  dialog.className = 'reda-alert';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${id}-title`);

  const style = document.createElement('style');
  style.textContent = `
    .reda-alert {
      box-sizing: border-box; width: min(440px, calc(100vw - 32px));
      max-height: calc(100dvh - 32px); overflow: auto; margin: auto;
      padding: 24px; border: 1px solid #e8e8e8; border-radius: 20px;
      background: #fff; color: #111; color-scheme: light;
      box-shadow: 0 16px 64px #0003;
      font-family: Montserrat, system-ui, sans-serif;
    }
    .reda-alert::backdrop { background: rgba(10,10,10,0.42); }
    .reda-alert h2 { margin: 0 0 12px; font-size: 20px; }
    .reda-alert p { margin: 0; font-size: 15px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
    .reda-alert-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin-top: 24px; }
    .reda-alert button {
      cursor: pointer; min-height: 44px; padding: 10px 18px; border: 1px solid #111;
      border-radius: 24px; background: #111; color: #fff; font: inherit; font-weight: 600;
    }
    .reda-alert button[data-style="cancel"] { background: #fff; color: #111; }
    .reda-alert button[data-style="destructive"] { background: #fff; border-color: #a02d1b; color: #a02d1b; }
    .reda-alert button:focus-visible { outline: 3px solid #2463eb; outline-offset: 3px; }
  `;
  dialog.append(style);

  const title = document.createElement('h2');
  title.id = `${id}-title`;
  title.textContent = request.title;
  dialog.append(title);
  if (request.message) {
    const message = document.createElement('p');
    message.id = `${id}-message`;
    message.textContent = request.message;
    dialog.setAttribute('aria-describedby', message.id);
    dialog.append(message);
  }

  let settled = false;
  function finish(callback?: () => void): void {
    if (settled) return;
    settled = true;
    dialog.close();
    dialog.remove();
    try {
      callback?.();
    } finally {
      showing = false;
      showNext();
    }
  }

  function dismiss(): void {
    // Native Android alerts are not dismissible unless explicitly enabled.
    if (options?.cancelable) finish(options.onDismiss);
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dismiss();
  });

  const actions = document.createElement('div');
  actions.className = 'reda-alert-actions';
  let initialFocus: HTMLButtonElement | undefined;
  for (const choice of request.buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.text ?? 'OK';
    button.dataset.style = choice.style ?? 'default';
    button.addEventListener('click', () => finish(choice.onPress));
    actions.append(button);
    if (!initialFocus || choice.style === 'cancel') initialFocus = button;
  }
  dialog.append(actions);
  document.body.append(dialog);
  dialog.showModal();
  initialFocus?.focus();
}
