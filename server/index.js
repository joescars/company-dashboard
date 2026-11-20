import 'dotenv/config';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT || 8080);
const app = createApp();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[company-dashboard] listening on http://0.0.0.0:${port}`);
});