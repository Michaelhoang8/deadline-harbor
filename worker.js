import { compare } from './core.js';
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: compare(data) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
