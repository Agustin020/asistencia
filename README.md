# Control de Asistencia · Seguridad (Mendotaku)

Planilla web para controlar la hora de **entrada y salida** del personal de seguridad, con
**plantilla de horarios** (turnos), **login**, **usuarios**, **roles y permisos**.
El personal de seguridad no entra al sistema: lo usan jefes y supervisores.

- **Backend:** Node.js + Express + PostgreSQL (`backend/`)
- **Frontend:** HTML/CSS/JS sin compilación, servido por el mismo backend (`frontend/`)
- **Base de datos:** Postgres. En tu PC funciona sin instalar nada (Postgres embebido, PGlite);
  en internet usa Neon (gratis).

## Qué hace

| Pantalla | Para qué |
|---|---|
| **Asistencia** | Planilla en vivo del día: contadores (ingresaron / faltan / salieron / total), filtro por turno y estado, búsqueda por nombre o DNI. Un toque marca la entrada; el botón **Salida** marca la salida. Avisa *Tarde*, *Demorado*, *Ausente* y *Salió antes*. Se actualiza sola cada 5 s, así varios supervisores pueden trabajar a la vez. **+ Agregar** suma a alguien al turno desde la puerta, **Copiar resumen** arma un texto para WhatsApp y **Exportar CSV** baja la planilla para Excel. |
| **Horarios** | Plantilla de turnos: nombre, fecha, hora de presentación y de fin (puede cruzar medianoche), lugar/puesto, tolerancia y color. Asignación del personal que debe presentarse en cada turno y **duplicar** turnos (por ej. de sábado a domingo con el mismo personal). |
| **Personal** | ABM del padrón (DNI, nombre, apellido, teléfono, observaciones, activo). **Importar lista** pegando desde Excel. |
| **Usuarios** | ABM de usuarios del sistema, con rol, activo/inactivo y reseteo de contraseña. |
| **Roles y permisos** | ABM de roles combinando permisos. Vienen creados *Administrador* (todo), *Jefe* y *Supervisor*. |
| **Actividad** | Registro de quién hizo qué y cuándo (marcas, correcciones, altas, bajas, ingresos). |

### Permisos disponibles

| Código | Permite |
|---|---|
| `asistencia.ver` | Ver la planilla |
| `asistencia.marcar` | Marcar entrada/salida (y deshacer la propia dentro de 5 minutos) |
| `asistencia.corregir` | Corregir horarios a mano y anular marcas de otros |
| `reportes.exportar` | Copiar resumen y exportar CSV |
| `turnos.ver` / `turnos.gestionar` | Ver / editar la plantilla de horarios y asignar personal |
| `personal.ver` / `personal.gestionar` | Ver / ABM del padrón |
| `usuarios.gestionar` | ABM de usuarios |
| `roles.gestionar` | ABM de roles (y asignar el rol Administrador) |
| `auditoria.ver` | Ver el registro de actividad |

Protecciones: no podés darte de baja ni cambiarte el rol a vos mismo, siempre queda al menos un
Administrador activo, y no se puede borrar a alguien del padrón que ya tiene asistencias (se lo desactiva).

## Probar en tu PC

Requiere Node.js 20.12 o superior.

```bash
npm install
```

```bash
npm start
```

Abrí http://localhost:3000 e ingresá con **admin / admin123** (cambiala desde el menú de usuario).
Los datos quedan en la carpeta `data/`. Para configurar algo, copiá `.env.example` como `.env`.

Orden sugerido: **Personal** (cargar o importar la lista) → **Horarios** (crear turnos y asignar
personal) → **Usuarios** (crear a los supervisores) → **Asistencia** el día del evento.

## Subir a internet gratis (Neon + Render)

### 1. Base de datos en Neon

1. Creá una cuenta en https://neon.tech (plan Free, no pide tarjeta).
2. Creá un proyecto (región *São Paulo* es la más cercana).
3. Copiá la **connection string** (`postgresql://...neon.tech/neondb?sslmode=require`).

Las tablas se crean solas la primera vez que arranca la app.

### 2. Subir el código a GitHub

Creá un repositorio (puede ser privado) y subí esta carpeta. El `.gitignore` ya excluye
`node_modules`, `data` y `.env`.

### 3. Servidor en Render

1. Creá una cuenta en https://render.com y conectá GitHub.
2. **New → Blueprint** y elegí el repositorio (usa `render.yaml`).
   *Alternativa:* **New → Web Service**, Build `npm ci --omit=dev`, Start `npm start`, plan **Free**.
3. Completá las variables:
   - `DATABASE_URL` → la cadena de Neon.
   - `ADMIN_PASSWORD` → la contraseña inicial del usuario `admin`.
   - `JWT_SECRET` se genera solo con el Blueprint (si lo hacés a mano, poné un texto largo cualquiera).
4. Deploy. Te queda una URL tipo `https://mendotaku-asistencia.onrender.com`.

### Tener en cuenta en el plan gratuito

- Render **duerme** el servicio tras 15 minutos sin uso y tarda ~1 minuto en despertar.
  Para el fin de semana, entrá un rato antes del evento o configurá un ping gratuito
  (por ej. https://cron-job.org o UptimeRobot) a `https://TU-APP.onrender.com/api/health` cada 10 minutos.
- Los datos viven en Neon, así que no se pierden aunque Render se reinicie.
- Al terminar el evento: exportá los CSV y, si querés, borrá el servicio y el proyecto de Neon.

## Estructura

```
backend/
  server.js     arranque de Express, sirve el frontend
  db.js         conexión (Postgres o PGlite), esquema y datos iniciales
  auth.js       login, sesiones (JWT), verificación de permisos, auditoría
  api.js        endpoints: roles, usuarios, personal, turnos, asistencia, auditoría
  permisos.js   catálogo de permisos y roles iniciales
frontend/
  index.html, styles.css, app.js
render.yaml     despliegue en Render
```
