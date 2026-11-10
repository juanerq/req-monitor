# MiAsistencia360 REQ checker

Automatización Playwright para consultar REQ, detectar respuestas de agentes y extraer enlaces visibles de adjuntos.

## Requisitos

- Node.js y pnpm.
- Acceso de red a MiAsistencia360.
- Navegador de Playwright instalado: `pnpm exec playwright install chromium`.

## Autenticación

```bash
pnpm run auth
```

Inicia sesión en el navegador. Cuando aparezca el catálogo, vuelve a la terminal y presiona Enter. La sesión se guarda en `AUTH_FILE` (por defecto `playwright/.auth/miasistencia.json`) y, cuando se proporciona, el usuario ingresado se guarda como etiqueta local en `username.json`, dentro de la misma carpeta privada. Nunca agregues estos archivos a Git. El nombre guardado no verifica la identidad del portal.

## Consultar una REQ

```bash
pnpm check-req --req REQ000007780445
```

También puedes usar una variable de entorno:

```bash
REQ_NUMBER=REQ000007780445 pnpm check-req
```

## Consultar varias REQ

Crea un archivo con una REQ por línea:

```text
REQ000007780445
REQ000007780446
```

Ejecuta:

```bash
pnpm check-req --file reqs.txt
```

El resultado se guarda en `artifacts/req-responses.json`. Usa `--output ruta.json` para cambiarlo y `--headed` para ver el navegador.

## Criterio de respuesta

El estado oficial del portal tiene prioridad: cuando está `Finalizado` (o `Completed`/`Finalized` en inglés), la conversación queda `Finalizada`. Para solicitudes abiertas, si el último comentario de Operaciones contiene `en validación` o `en proceso de validación`, queda `En validación` y no genera una alerta de acción requerida. En los demás casos, la automatización identifica el comentario más reciente de Operaciones como el primer comentario cuyo autor es distinto del solicitante. Cuando «Petición para» incluye además inicial, ID y correo, usa el nombre identificado en el encabezado si coincide exactamente con una línea de esa tarjeta; si no puede identificarlo, no atribuye comentarios a Operaciones. La conversación queda `Respondida` cuando existe al menos un comentario o adjunto del solicitante posterior a ese comentario de Operaciones. Si Operaciones comentó y el solicitante todavía no contestó, queda `Pendiente de respuesta`. Los resultados guardados antes de esta corrección requieren una nueva consulta para actualizar su clasificación; no se modifican automáticamente.

El estado original del portal se conserva en `status`. El estado calculado se entrega en `conversationStatus`, junto con `latestOperationsComment` y `requesterRepliesAfterOperations`.

Cada resultado incluye estado, solicitante, comentarios, respuestas de agentes, respuesta más reciente y adjuntos. Algunos enlaces de descarga son temporales o requieren la sesión autenticada.

## Notificaciones opcionales en Microsoft Teams

Sin `TEAMS_WEBHOOK_URL`, el monitor consulta y guarda resultados normalmente, pero no envía alertas a Teams. Para activar las alertas, configura un webhook válido como variable de entorno; si compartiste uno antes, regenéralo:

```bash
export TEAMS_WEBHOOK_URL="https://..."
```

También puedes crear un `.env` local, ignorado por Git:

```dotenv
TEAMS_WEBHOOK_URL=https://...
```

Para usar el monitor desde la terminal, crea `reqs.txt` con una REQ por línea (como en «Consultar varias REQ»). En Docker puedes agregarlas desde la interfaz web, sin preparar ese archivo. Ejecuta el monitor local:

```bash
pnpm monitor-req
```

Para ejecutar solo algunas REQ desde la terminal, indica `--req` una vez por número (no se combina con `--file`):

```bash
pnpm monitor-req --req REQ123 --req REQ456
```

Las REQ no seleccionadas conservan sus resultados y su estado previo de alertas.

El monitor consulta las REQ y notifica cuando una conversación entra en `Pendiente de respuesta`, cuando detecta un comentario nuevo de Operaciones aunque el portal siga en «Pendiente» o no se pueda confirmar el orden de los comentarios, y cuando el estado oficial cambia a `Finalizada`. Una fecha recuperada de un comentario ya conocido no genera otra alerta; un comentario idéntico adicional se distingue cuando se conoce la lista de comentarios. No reenvía comentarios históricos ya conocidos al actualizar la aplicación. Las alertas pendientes usan color rojo, los comentarios nuevos sin certeza de acción requerida tienen una tarjeta informativa y las finalizadas color verde. Guarda el estado y la huella del comentario en `artifacts/req-status.json` para no repetir alertas; un envío fallido no confirma la entrega.

Si el comentario vigente de Operaciones indica fecha y hora explícitas, la tabla muestra el **plazo indicado** en hora de Colombia; no es una fecha de cierre confirmada. Sin fecha explícita aparece «Sin plazo indicado», y tras respuesta o finalización, «Plazo inactivo». Mientras la REQ sigue pendiente, el monitor envía como máximo un recordatorio por ciclo y día entre las 08:00 y las 11:59 de Colombia. Una alerta nueva del mismo ciclo sustituye el recordatorio de esa mañana. Ejecuciones manuales fuera de esa ventana no envían recordatorios; `--dry-run` no registra entregas.

Prueba sin enviar ni modificar estado:

```bash
pnpm monitor-req --dry-run
```

Prueba solamente el webhook (requiere `TEAMS_WEBHOOK_URL`):

```bash
pnpm monitor-req --test-notification
```

El monitor envía una Adaptive Card con el proyecto observado, cuando está disponible, los microservicios detectados y las URLs de Pull Request encontradas en `Descripción Detallada de la Solicitud`. Para solicitudes de análisis de código estático sin microservicios explícitos, también puede tomar los nombres de paquetes de código adjuntos (`.7z`, `.zip`, `.rar`, `.tar.gz`), sin usar informes PDF ni inferir el proyecto. El botón `Abrir REQ` usa el enlace compartible oficial de MiAsistencia360 y dirige al detalle específico después de autenticarse. Un HTTP `202 Accepted` confirma que Power Automate recibió la solicitud; confirma la publicación en Teams desde el historial de ejecuciones del workflow.

En solicitudes de creación y configuración de repositorios/pipelines, si faltan etiquetas explícitas de microservicio, se reconocen pares `Nombre:` seguido de `Proyecto:` en la descripción cuando esta menciona repositorios. La tabla puede mostrar esos nombres también para resultados ya guardados, sin reescribir el archivo ni consultar el portal; las notificaciones históricas no se modifican.

### Ejecución programada

Scheduler interno ejecuta cada 15 minutos, alineado al reloj de Colombia (`America/Bogota`), únicamente:

- Lunes a viernes.
- De 08:00 a 12:00, incluyendo 12:00.
- De 14:00 a 18:00, incluyendo 18:00.
- Días que no sean festivos oficiales de Colombia.

Ejecución al iniciar, scheduler y botón `Ejecutar monitor` respetan calendario. Consulta individual de una REQ está disponible a cualquier hora y no modifica lista monitoreada ni envía alertas.

## API para administrar REQ

Inicia API local:

```bash
pnpm monitor-api
```

Listar REQ:

```bash
curl http://127.0.0.1:8787/api/reqs
```

Reemplazar lista completa:

```bash
curl -X PUT http://127.0.0.1:8787/api/reqs \
  -H 'Content-Type: application/json' \
  -d '{"reqs":["REQ000007780316","REQ000007780445"]}'
```

Protección anti-pérdida: por defecto, `PUT /api/reqs` no reduce la lista actual; si envías menos REQ de las existentes, combina ambas listas para evitar que desaparezcan del monitoreo por accidente. Para reemplazo total intencional usa `replace=true`:

```bash
curl -X PUT 'http://127.0.0.1:8787/api/reqs?replace=true' \
  -H 'Content-Type: application/json' \
  -d '{"reqs":["REQ000007780316","REQ000007780445"]}'
```

Agregar o eliminar una REQ:

```bash
curl -X POST http://127.0.0.1:8787/api/reqs \
  -H 'Content-Type: application/json' \
  -d '{"req":"REQ000007780295"}'

curl -X DELETE http://127.0.0.1:8787/api/reqs/REQ000007780295
```

Ejecutar monitor y consultar estado:

```bash
curl -X POST http://127.0.0.1:8787/api/monitor/run
curl http://127.0.0.1:8787/api/monitor/status
```

Para una ejecución manual parcial, envía `{"reqs":["REQ123","REQ456"]}` a `POST /api/monitor/run`. La API rechaza selecciones vacías, REQ que no estén en la lista monitoreada y REQ bloqueadas. Una solicitud sin `reqs` ejecuta todas las REQ disponibles (no bloqueadas). Las ejecuciones programadas aplican el mismo bloqueo. Una REQ cuyo estado literal del portal sea `Finalizado` queda bloqueada hasta que se desbloquee desde Acciones; el desbloqueo se conserva tras recargar y permite una nueva revisión aunque continúe `Finalizado`. Si esa revisión vuelve a devolver `Finalizado`, queda bloqueada otra vez. El candado abierto permite volver a bloquearla antes de esa revisión.

Cuando una REQ previamente notificada como «Pendiente de respuesta» pasa a «Respondida», se envía una tarjeta nueva de resolución sin «Acción requerida». Las tarjetas muestran los datos principales como campos etiquetados y separan comentarios y adjuntos del botón para abrir la REQ. Los webhooks de Teams no modifican tarjetas enviadas anteriormente; las tarjetas históricas permanecen como registro del estado anterior.

API no usa token y debe permanecer publicada exclusivamente en `127.0.0.1`.

## Interfaz web

Con API activa, abre `http://127.0.0.1:8787`. La interfaz permite:

- Ver estado y última revisión de las REQ monitoreadas, ordenadas de la última revisión a la primera; las REQ nuevas sin revisión aparecen al inicio.
- La tabla muestra el estado literal observado en el portal; si falta, indica «Estado no disponible». El estado de conversación calculado aparece por separado en «Ver detalles» y sigue rigiendo alertas y recordatorios.
- El proyecto observado se extrae de una línea explícita `Proyecto:` en la descripción detallada del portal. Si falta, la tabla puede mostrar un proyecto **inferido** cuando el microservicio coincide con el de otra REQ configurada que sí tiene proyecto; «Ver detalles» identifica el valor inferido. Ante proyectos distintos o ninguna coincidencia, permanece «Proyecto no disponible». La inferencia no cambia los resultados guardados, la consulta manual ni las tarjetas de Teams. Para obtener nuevos datos del portal, ejecuta el monitor; «Actualizar» solo recarga datos locales.
- «Ver detalles» despliega únicamente datos ya guardados: descripción, instrucciones, metadatos, solicitante y fechas disponibles. Los datos personales permanecen ocultos hasta abrir el panel; los campos ausentes se indican como no disponibles. No realiza una consulta adicional al portal.
- Pegar una o varias REQ, separadas por comas, espacios o saltos de línea, para agregarlas al monitoreo en una sola operación sin iniciar su análisis; también se pueden eliminar de `runtime/reqs.txt`. El scheduler independiente podrá analizarlas en su siguiente ciclo permitido.
- En **Configuración**, ajustar el intervalo automático de 0 a 1440 minutos (`0` pausa el scheduler). Se guarda en `runtime/settings.json`, se aplica al próximo ciclo sin iniciar uno inmediato y prevalece sobre `MONITOR_INTERVAL_MINUTES`; los monitoreos manuales siguen disponibles.
- Seleccionar en la tabla qué REQ disponibles ejecutar con **Ejecutar monitor**; sin selección, el botón no inicia nada. Las REQ bloqueadas con estado del portal `Finalizado` no se ejecutan ni manual ni automáticamente, sin eliminarlas de la lista ni borrar sus resultados.
- La casilla de la cabecera de selección, a la izquierda de «Proyecto / Microservicio / REQ», marca o desmarca todas las REQ no bloqueadas, incluso las ocultas por filtros o en otras páginas.
- Los indicadores Total, Pendientes, Respondidas, En validación y Finalizadas cuentan las REQ que pasan los filtros de la tabla, incluidas las de otras páginas. «Limpiar filtros» quita todos los filtros de columnas y restablece los indicadores; no modifica la selección ni los resultados guardados.
- La columna «Estado del portal» conserva el estado literal y muestra por separado el estado calculado de la conversación; cuando se detecta un comentario de Operaciones, aparece «Respuesta de Operaciones registrada». Si no hay fechas suficientes para ordenar los comentarios, la clasificación calculada no confirma quién debe responder a continuación.
- **Ejecutar todas** selecciona las REQ no bloqueadas y arranca una ejecución manual con un clic. **Ejecutar monitor** conserva la ejecución de solo las REQ seleccionadas.
- El candado en **Acciones** desbloquea una REQ `Finalizado` para una nueva revisión incluso si sigue con ese estado; si la revisión vuelve a devolver `Finalizado`, se bloquea automáticamente. Se puede bloquear antes con el mismo control. La fila coloreada identifica la REQ que está en revisión, sin texto adicional junto al número.
- Consultar una REQ específica sin agregarla al monitoreo ni enviar alertas a Teams.
- Descargar adjuntos mediante sesión autenticada del backend, sin abrir enlaces REST expirados.
- Consultar desde `Acceso` si existe una sesión local y ver el usuario ingresado anteriormente, sin exponer contraseña ni cookies. Su presencia no confirma que el portal permita el acceso; `GET /api/auth/status` devuelve únicamente `localSessionAvailable` y `username`.
- Iniciar sesión manualmente desde `Acceso` cuando el portal solicite nuevamente la contraseña. La contraseña se borra del formulario después del intento o al cerrarlo; no se guarda.

Los resultados en `artifacts/monitor-results.json` (o la ruta `--output`) contienen datos personales del solicitante en texto claro. Guarda ese archivo y sus copias solo en almacenamiento local protegido, limita el acceso a la API local (`127.0.0.1`) y no compartas resultados ni capturas del panel. Los detalles abiertos se eliminan del DOM al cerrarlos o al actualizar la tabla; la interfaz actualiza los datos guardados cada 15 segundos, pero **Actualizar** solo recarga datos locales y no consulta el portal. Para obtener información nueva del portal, ejecuta el monitor o consulta una REQ manualmente; un campo no observado continúa como no disponible.

Consulta manual equivalente por API:

```bash
curl -X POST http://127.0.0.1:8787/api/reqs/query \
  -H 'Content-Type: application/json' \
  -d '{"req":"REQ000007780445"}'
```

## Compilación del frontend

Después de instalar las dependencias con `pnpm install`, ejecuta `pnpm typecheck` y `pnpm build` antes de iniciar la API local. Vite compila `web/app.ts` en `dist/app.js`; la API conserva la ruta `/app.js` y el HTML existente. `pnpm test` compila el frontend y ejecuta las pruebas. Docker Compose compila el frontend dentro de la imagen.

## Docker Compose

El contenedor ejecuta API y scheduler interno. No necesita cron dentro del contenedor ni un archivo `.env` para iniciar sin alertas de Teams.

```bash
install -d -m 700 runtime artifacts playwright/.auth
docker compose up -d --build
docker compose ps
```

Abre `http://127.0.0.1:8787` y agrega las REQ a monitorear desde la interfaz; no necesitas `reqs.txt.example`. Para activar Teams, crea un `.env` local con `TEAMS_WEBHOOK_URL=https://...` antes de iniciar el contenedor. Si el webhook falta, Teams queda desactivado, pero el monitoreo, el dashboard y el guardado de resultados siguen funcionando. Las variables de `.env` se cargan si el archivo existe.

Configuración predeterminada:

- Consulta cada 15 minutos dentro de ventanas laborales de Colombia, excluyendo fines de semana y festivos.
- API publicada solo en `127.0.0.1:8787` del servidor.
- `./runtime` montado en `/data`: REQ persistidas en `runtime/reqs.txt`.
- `./artifacts` montado en `/app/artifacts`: resultados y estado persistidos.
- `./playwright/.auth` montado en `/app/playwright/.auth`: sesión Playwright persistida con escritura para renovarla desde la interfaz.

Comandos operativos:

```bash
docker compose logs -f monitor
docker compose restart monitor
docker compose down
```

### Acceso mediante túnel SSH y Nginx

La API no incluye autenticación propia. Mantén Docker en `127.0.0.1:8787` y Nginx en `127.0.0.1:8088`; **no** publiques ninguno de esos puertos. SSH controla quién puede abrir el túnel. No cambies el sitio Nginx existente que atiende el puerto 80.

Desde la raíz del proyecto en el servidor, instala el sitio separado (requiere privilegios de administrador):

```bash
sudo install -m 644 deploy/nginx-ssh-tunnel.conf /etc/nginx/sites-available/req-monitor-ssh
sudo ln -s /etc/nginx/sites-available/req-monitor-ssh /etc/nginx/sites-enabled/req-monitor-ssh
sudo nginx -t && sudo systemctl reload nginx
curl -fsS http://127.0.0.1:8088/health
```

Desde tu computadora, abre el túnel con una cuenta SSH autorizada para esta máquina (sustituye `usuario@servidor` por tu conexión habitual):

```bash
ssh -N -L 127.0.0.1:8088:127.0.0.1:8088 usuario@servidor
```

Mientras esa conexión esté abierta, visita `http://127.0.0.1:8088` **en tu computadora**. Si el puerto 8088 está ocupado allí, cambia solo el primer `8088` del comando SSH y usa ese mismo puerto en el navegador. El túnel cifra el transporte; no convierte el panel en un servicio público ni reemplaza la protección de tu cuenta SSH.

El monitor intenta reutilizar el estado local primero; un archivo presente no garantiza una sesión vigente ni implica renovación automática. Si el portal exige iniciar sesión, usa `Acceso` y proporciona la contraseña manualmente. Los errores de red no demuestran que la sesión haya expirado. La sesión Playwright y la etiqueta de usuario ingresado persisten en el volumen `playwright/.auth`; la contraseña no. La API no tiene autenticación propia: mantenla exclusivamente en el loopback local y protege el directorio montado como credencial.
