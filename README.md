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

Inicia sesión en el navegador. Cuando aparezca el catálogo, vuelve a la terminal y presiona Enter. La sesión se guarda en `playwright/.auth/miasistencia.json`; nunca agregues ese archivo a Git.

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

## Notificaciones en Microsoft Teams

Regenera cualquier webhook que hayas compartido y configura la nueva URL solo como variable de entorno:

```bash
export TEAMS_WEBHOOK_URL="https://..."
```

También puedes crear un `.env` local, ignorado por Git:

```dotenv
TEAMS_WEBHOOK_URL=https://...
```

Copia `reqs.txt.example` como `reqs.txt` y agrega una REQ por línea. Ejecuta el monitor:

```bash
pnpm monitor-req
```

El monitor consulta las REQ y notifica cuando una conversación entra en `Pendiente de respuesta`, cuando Operaciones agrega un comentario nuevo mientras continúa pendiente y cuando el estado oficial cambia a `Finalizada`. Las alertas pendientes usan color rojo y las finalizadas color verde. Guarda el estado y una huella del comentario en `artifacts/req-status.json` para no repetir alertas.

Prueba sin enviar ni modificar estado:

```bash
pnpm monitor-req --dry-run
```

Prueba solamente el webhook:

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
- Agregar y eliminar REQ de `runtime/reqs.txt`.
- Ejecutar monitor completo bajo demanda.
- Consultar una REQ específica sin agregarla al monitoreo ni enviar alertas a Teams.
- Descargar adjuntos mediante sesión autenticada del backend, sin abrir enlaces REST expirados.
- Renovar sesión MiAsistencia360 desde botón discreto `Acceso`; credenciales no se guardan.

Consulta manual equivalente por API:

```bash
curl -X POST http://127.0.0.1:8787/api/reqs/query \
  -H 'Content-Type: application/json' \
  -d '{"req":"REQ000007780445"}'
```

## Docker Compose

El contenedor ejecuta API y scheduler interno. No necesita cron dentro del contenedor.

```bash
docker compose build
docker compose up -d
docker compose ps
```

Configuración predeterminada:

- Consulta cada 15 minutos dentro de ventanas laborales de Colombia, excluyendo fines de semana y festivos.
- API publicada solo en `127.0.0.1:8787` del servidor.
- REQ persistidas en `runtime/reqs.txt`.
- Estado y logs persistidos en `artifacts/`.
- Sesión Playwright montada desde `playwright/.auth/` con escritura para renovarla desde interfaz.

Comandos operativos:

```bash
docker compose logs -f monitor
docker compose restart monitor
docker compose down
```

Si sesión expira, usa botón `Acceso` en interfaz. Usuario y contraseña solo se usan durante login; se persiste únicamente sesión Playwright en `playwright/.auth/miasistencia.json`.
