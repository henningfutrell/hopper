// Both pages' one behaviour: a command's Copy button copies it (issue #382). The button keeps its width
// whatever it says, and a polite live region tells a screen reader that it copied.
import './site.css';

const status = document.createElement('p');
status.className = 'sr-only';
status.setAttribute('aria-live', 'polite');
document.body.append(status);

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  let reset: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    const command = button.dataset.copy ?? '';
    navigator.clipboard.writeText(command).then(
      () => {
        button.textContent = 'Copied';
        button.dataset.copied = '';
        status.textContent = 'Copied to the clipboard.';
      },
      () => {
        button.textContent = 'Select it';
        status.textContent = 'Could not copy: select the command and copy it.';
      },
    );
    clearTimeout(reset);
    reset = setTimeout(() => {
      button.textContent = 'Copy';
      delete button.dataset.copied;
      status.textContent = '';
    }, 2000);
  });
}
