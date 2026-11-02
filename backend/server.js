import './env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb } from './db.js';
import { authRouter } from './auth.js';
import api from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(__dirname, '..', 'frontend');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.body ??= {};
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ evento: process.env.EVENT_NAME || 'Mendotaku' }));
app.use('/api/auth', authRouter);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta inexistente' }));

// no-cache: el navegador revalida siempre, así los celulares toman la última versión tras cada deploy.
app.use(express.static(FRONTEND, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.use((req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Ya existe un registro con ese dato (DNI, usuario o nombre repetido)' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  console.warn('⚠ Producción sin DATABASE_URL: los datos se guardan en disco local y pueden perderse al reiniciar.');
}

const motor = await initDb();
app.listen(PORT, () => console.log(`Asistencia lista en http://localhost:${PORT} · base de datos: ${motor}`));
