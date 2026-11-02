// Catálogo fijo de permisos. Los roles se arman combinando estos códigos.
export const PERMISOS = {
  'asistencia.ver': 'Ver la planilla de asistencia',
  'asistencia.marcar': 'Marcar entrada y salida del personal',
  'asistencia.corregir': 'Corregir o anular horarios ya marcados',
  'reportes.exportar': 'Copiar resumen y exportar CSV',
  'turnos.ver': 'Ver la plantilla de horarios',
  'turnos.gestionar': 'Crear y editar turnos y asignar personal',
  'personal.ver': 'Ver el padrón de personal',
  'personal.gestionar': 'Alta, baja y modificación de personal',
  'usuarios.gestionar': 'Alta, baja y modificación de usuarios',
  'roles.gestionar': 'Alta, baja y modificación de roles y permisos',
  'auditoria.ver': 'Ver el registro de actividad',
};

export const TODOS = Object.keys(PERMISOS);

// Roles que se crean la primera vez que arranca el sistema.
export const ROLES_INICIALES = [
  {
    nombre: 'Jefe',
    descripcion: 'Gestiona personal, horarios, usuarios y asistencia',
    permisos: TODOS.filter((p) => p !== 'roles.gestionar'),
  },
  {
    nombre: 'Supervisor',
    descripcion: 'Marca entradas y salidas en la puerta',
    permisos: ['asistencia.ver', 'asistencia.marcar', 'reportes.exportar', 'turnos.ver', 'personal.ver'],
  },
];
