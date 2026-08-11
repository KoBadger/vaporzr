import App from './App';
import { ensureTopButton } from './topbar';

export default function render() {
  ensureTopButton();
  return App();
}
