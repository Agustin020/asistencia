// Carga variables desde .env (si existe) antes que cualquier otro módulo.
try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan las variables del entorno (Render, etc.)
}
