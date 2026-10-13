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

El estado oficial del portal tiene prioridad: cuando está `Finalizado` (o `Completed`/`Finalized` en inglés), la conversación queda `Finalizada`. Para solicitudes abiertas, si el último comentario de Operaciones contiene `en validación` o `en proceso de validación`, queda `En validación` y no genera una alerta de acción requerida. En los demás casos, la automatización identifica el comentario más reciente de Operaciones como el primer comentario cuyo autor es distinto del solicitante. La conversación queda `Respondida` cuando existe al menos un comentario o adjunto del solicitante posterior a ese comentario de Operaciones. Si Operaciones comentó y el solicitante todavía no contestó, queda `Pendiente de respuesta`.

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

El monitor consulta las REQ y notifica cuando una conversación entra en `Pendiente de respuesta`, cuando Operaciones agrega un comentario nuevo mientras continúa pendiente y cuando el estado oficial cambia a `Finalizada`. Las alertas pendientes usan color rojo y las finalizadas color verde. Guarda el estado y una huella del comentario en `artifacts/req-status.json` para no repetir alertas.

Si el comentario vigente de Operaciones indica fecha y hora explícitas, la tabla muestra el **plazo indicado** en hora de Colombia; no es una fecha de cierre confirmada. Sin fecha explícita aparece «Sin plazo indicado», y tras respuesta o finalización, «Plazo inactivo». Mientras la REQ sigue pendiente, el monitor envía como máximo un recordatorio por ciclo y día entre las 08:00 y las 11:59 de Colombia. Una alerta nueva del mismo ciclo sustituye el recordatorio de esa mañana. Ejecuciones manuales fuera de esa ventana no envían recordatorios; `--dry-run` no registra entregas.

Prueba sin enviar ni modificar estado:

```bash
pnpm monitor-req --dry-run
```

Prueba solamente el webhook (requiere `TEAMS_WEBHOOK_URL`):

```bash
pnpm monitor-req --test-notification
```

El monitor envía una Adaptive Card con el nombre de los microservicios y las URLs de Pull Request encontrados en `Descripción Detallada de la Solicitud`. El botón `Abrir REQ` usa el enlace compartible oficial de MiAsistencia360 y dirige al detalle específico después de autenticarse. Un HTTP `202 Accepted` confirma que Power Automate recibió la solicitud; confirma la publicación en Teams desde el historial de ejecuciones del workflow.

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

API no usa token y debe permanecer publicada exclusivamente en `127.0.0.1`.

## Interfaz web

Con API activa, abre `http://127.0.0.1:8787`. La interfaz permite:

- Ver estado y última revisión de las REQ monitoreadas.
- La tabla muestra el estado literal observado en el portal; si falta, indica «Estado no disponible». El estado de conversación calculado aparece por separado en «Ver detalles» y sigue rigiendo alertas y recordatorios.
- «Ver detalles» despliega únicamente datos ya guardados: descripción, instrucciones, metadatos, solicitante y fechas disponibles. Los datos personales permanecen ocultos hasta abrir el panel; los campos ausentes se indican como no disponibles. No realiza una consulta adicional al portal.
- Agregar y eliminar REQ de `runtime/reqs.txt`.
- Ejecutar monitor completo bajo demanda.
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

## Docker Compose

El contenedor ejecuta API y scheduler interno. No necesita cron dentro del contenedor ni un archivo `.env` para iniciar sin alertas de Teams.

```bash
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

El monitor intenta reutilizar el estado local primero; un archivo presente no garantiza una sesión vigente ni implica renovación automática. Si el portal exige iniciar sesión, usa `Acceso` y proporciona la contraseña manualmente. Los errores de red no demuestran que la sesión haya expirado. La sesión Playwright y la etiqueta de usuario ingresado persisten en el volumen `playwright/.auth`; la contraseña no. La API no tiene autenticación propia: mantenla exclusivamente en el loopback local y protege el directorio montado como credencial.
