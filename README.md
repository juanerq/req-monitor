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

El monitor consulta las REQ y notifica cuando una conversación entra en `Pendiente de respuesta`, cuando detecta un comentario nuevo de Operaciones aunque el portal siga en «Pendiente» o no se pueda confirmar el orden de los comentarios, y cuando el estado oficial cambia a `Finalizada`. Una fecha recuperada de un comentario ya conocido no genera otra alerta; un comentario idéntico adicional se distingue cuando se conoce la lista de comentarios. No reenvía comentarios históricos ya conocidos al actualizar la aplicación. Las alertas pendientes usan color rojo y los comentarios nuevos sin certeza de acción requerida tienen una tarjeta informativa. Para una REQ finalizada, el resultado del cierre se muestra por separado del estado del portal: verde solo con aprobación explícita en el último comentario de Operaciones; ámbar si el comentario indica cierre por falta de información o documentación; neutro si falta evidencia o hay mensajes contradictorios. El tablero muestra el mismo resultado, incluso para resultados históricos guardados, sin modificar el estado original del portal. La tarjeta conserva el comentario y el enlace a la REQ. El cierre y su comentario vigente se notifican una vez, no como dos alertas simultáneas. Guarda el estado y la huella del comentario en `artifacts/req-status.json` para no repetir alertas; un envío fallido no confirma la entrega.

Los recordatorios y avisos de plazo próximo incluyen el título, proyecto, microservicios, estado y último comentario de Operaciones cuando están disponibles, además del plazo y el enlace a la REQ. Esto no modifica la frecuencia ni las reglas de entrega.

El nombre de quien revisó puede figurar en una línea `--Revisa: Nombre` dentro del comentario de Operaciones. En ese caso el historial, el resultado manual y los mensajes nuevos muestran ese nombre en lugar del titular del perfil; los comentarios y las claves de deduplicación guardados no cambian. Si no hay firma válida, se conserva el nombre registrado por el portal. Una fecha indicada solo como día, incluso si después aparece `_ 72 horas`, se muestra sin inventar una hora y no activa avisos automáticos. Si no se identifica ningún plazo y el último comentario de Operaciones tiene fecha confiable, la tabla muestra un **plazo estimado** de tres días hábiles de Colombia (sin contar sábados, domingos ni festivos); la estimación tampoco activa avisos de Teams ni modifica los resultados guardados.

La tabla muestra el **plazo indicado** como `AAAA-MM-DD HH:mm` en hora de Colombia cuando el comentario incluye una hora; si solo hay fecha, muestra `AAAA-MM-DD` sin inventar una hora. No es una fecha de cierre confirmada. Si no se puede confirmar el orden de los comentarios, la tabla lo advierte en el estado de conversación. Cuando una fecha indicada sin hora ya pasó y su vigencia no está confirmada, aparece «Fecha indicada ya pasó · vigencia sin confirmar», no «Plazo vencido». No se envían recordatorios automáticos por fechas sin hora. Sin fecha explícita aparece «Sin plazo indicado», y tras una respuesta confirmada o finalización, «Plazo inactivo». Cuando queda menos de 24 horas para un plazo activo con hora, la tabla indica «Vence en menos de 24 horas»; cuando ese plazo ya pasó sin respuesta, indica «Plazo vencido». El monitor prepara una sola alerta de «Plazo próximo» por ciclo para Teams si las notificaciones están habilitadas. Una alerta de estado o un comentario nuevo de Operaciones tiene prioridad; el aviso de proximidad no duplica el recordatorio matutino de ese día. Fuera de ese aviso, mientras la REQ sigue pendiente y tiene un plazo con hora, el monitor envía como máximo un recordatorio por ciclo y día entre las 08:00 y las 11:59 de Colombia. Una alerta nueva del mismo ciclo sustituye el recordatorio de esa mañana. Ejecuciones manuales fuera de esa ventana no envían recordatorios ordinarios; `--dry-run` no registra entregas.
La columna «Última actividad» muestra la última respuesta con fecha y hora `AAAA-MM-DD HH:mm` y su autor, cuando están disponibles. En «Seguimiento y plazos», el panel de detalle conserva las fechas individuales del usuario y de Operaciones, así como la fecha de envío y revisión. Para el usuario exige que el autor coincida con el solicitante y que sus comentarios tengan fechas comparables (incluido el formato del portal `día/mes/año, hora a. m./p. m.`). Si no se puede determinar la fecha, muestra «Fecha no disponible»; si no existe respuesta, «Sin respuesta registrada». La **última revisión del monitor** aparece en el encabezado, incluso fuera del horario de consulta. El tablero no consulta el portal automáticamente para completar fechas ausentes.

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

Los faltantes manuales de una REQ monitoreada se actualizan con `PUT /api/reqs/:req/missing-tags`. Envía `{"tags":["documentation_md","logging_standard","consumption_example"]}` (cualquier subconjunto, sin duplicados); `[]` borra sus tags. `GET /api/dashboard` devuelve `missingTags` por REQ. La API rechaza identificadores no monitoreados y tags desconocidos.

Ejecutar monitor y consultar estado:

```bash
curl -X POST http://127.0.0.1:8787/api/monitor/run
curl http://127.0.0.1:8787/api/monitor/status
```

Para una ejecución manual parcial, envía `{"reqs":["REQ123","REQ456"]}` a `POST /api/monitor/run`. La API rechaza selecciones vacías, REQ que no estén en la lista monitoreada y REQ bloqueadas. Una solicitud sin `reqs` ejecuta todas las REQ disponibles (no bloqueadas). Las ejecuciones programadas aplican el mismo bloqueo. Cualquier REQ se puede bloquear o desbloquear desde Acciones; el bloqueo manual se conserva tras recargar y hasta que se desbloquee, y se elimina si la REQ se borra de la lista. Una REQ cuyo estado literal del portal sea `Finalizado` también queda bloqueada automáticamente hasta que se desbloquee desde Acciones; ese desbloqueo permite una nueva revisión aunque continúe `Finalizado`. Si esa revisión vuelve a devolver `Finalizado`, queda bloqueada otra vez.

Cuando una REQ previamente notificada como «Pendiente de respuesta» pasa a «Respondida», se envía una tarjeta nueva de resolución sin «Acción requerida». Las tarjetas muestran los datos principales como campos etiquetados y separan comentarios y adjuntos del botón para abrir la REQ. Los webhooks de Teams no modifican tarjetas enviadas anteriormente; las tarjetas históricas permanecen como registro del estado anterior.

API no usa token y debe permanecer publicada exclusivamente en `127.0.0.1`.

## Interfaz web

Con API activa, abre `http://127.0.0.1:8787`. La interfaz permite:

- Usar la franja de seguimiento para ver y filtrar el total monitoreado, los pendientes, las respuestas con fecha registrada en los últimos siete días y los plazos activos vencidos o que vencen en menos de 24 horas. Los totales se calculan antes de aplicar los filtros; cada filtro activo se puede quitar por separado.
- Cuando una REQ está por vencer, la tabla destaca la fila en ámbar y muestra un reloj junto al plazo. Las REQ vencidas conservan el indicador rojo.
- Buscar por número de REQ, proyecto o microservicio. Los filtros de conversación y portal respetan la diferencia entre ambos estados. «Filtros avanzados» reúne los filtros específicos, incluidos los de fecha, tipo y bloqueo; la tabla conserva la paginación y selección.
- Abrir el detalle en un panel lateral para revisar el historial, los datos guardados y los adjuntos disponibles. El menú de tres puntos reúne la consulta, el enlace al portal, el bloqueo y la eliminación. Pulsa el número de REQ para copiarlo o el nombre del microservicio para copiarlo. Si hay varios microservicios en la fila, se copian juntos, separados por comas.
- «Consulta directa» y «Configuración» abren paneles sin quitar espacio a la tabla. El selector de tema cambia entre claro y oscuro y conserva la preferencia en el navegador.
- La tabla muestra por separado el estado de conversación calculado y el estado literal observado en el portal; si este último falta, indica «Estado no disponible». Ambos también aparecen en «Ver detalles»; el estado de conversación sigue rigiendo alertas y recordatorios.
- El proyecto observado se extrae de una línea explícita `Proyecto:` en la descripción detallada del portal. Si falta, la tabla puede mostrar un proyecto **inferido** cuando el microservicio coincide con el de otra REQ configurada que sí tiene proyecto; «Ver detalles» identifica el valor inferido. Ante proyectos distintos o ninguna coincidencia, permanece «Proyecto no disponible». La inferencia no cambia los resultados guardados, la consulta manual ni las tarjetas de Teams. Para obtener nuevos datos del portal, ejecuta el monitor; la tabla recarga datos locales automáticamente.
- El título de la solicitud aparece en una sola línea debajo del número de REQ, dentro de la columna de identidad; la columna «Detalle» ya no ocupa espacio por separado. El título sigue disponible para buscar y filtrar, y «Ver detalles» muestra el texto completo sin recortarlo.
- «Crear REQ» abre una ventana con los tipos disponibles. «Análisis de código estático» muestra los siete parámetros de configuración obligatorios (sede, tipo de operación, servicio, tipo de solicitud, tipo de cliente, dirección IP y cantidad de usuarios), el mensaje sugerido con botones para editar la plantilla y copiar el texto guardado, y la instrucción de adjuntar un archivo en 7zip. Los cambios de plantilla se guardan solo en el navegador actual y permanecen al recargar; no modifican otras sesiones o navegadores. El icono junto al título abre el formulario de MiAsistencia360 en otra pestaña; la solicitud se crea manualmente en el portal, no se envía ni se agrega al monitoreo desde el tablero. Validación SSD queda pendiente de su URL e instrucciones específicas.
- «Ver detalles» despliega únicamente datos ya guardados: descripción, instrucciones, historial de conversación, metadatos, solicitante y fechas disponibles. Los datos personales permanecen ocultos hasta abrir el panel; los campos ausentes se indican como no disponibles. No realiza una consulta adicional al portal. Los mensajes de Operaciones ocupan todo el ancho disponible, separan las líneas con espacio y omiten solo las comillas externas; las comillas internas se conservan.
- En «Ver detalles» se pueden marcar manualmente los faltantes de MD de documentación, estándar de logs y ejemplo de consumo. Los tags aparecen bajo la REQ en la tabla y se guardan en `runtime/settings.json`; no se infieren del texto del portal ni modifican el monitoreo o Teams. Se eliminan de la configuración cuando se quita la REQ del monitoreo.
- Pegar una o varias REQ, separadas por comas, espacios o saltos de línea, para agregarlas al monitoreo en una sola operación sin iniciar su análisis; también se pueden eliminar de `runtime/reqs.txt`. El scheduler independiente podrá analizarlas en su siguiente ciclo permitido.
- En **Configuración** (engranaje junto a **Iniciar sesión**), ajustar el intervalo automático de 0 a 1440 minutos (`0` pausa el scheduler). Se guarda en `runtime/settings.json`, se aplica al próximo ciclo sin iniciar uno inmediato y prevalece sobre `MONITOR_INTERVAL_MINUTES`; los monitoreos manuales siguen disponibles.
- Seleccionar en la tabla qué REQ disponibles ejecutar con **Ejecutar selección**; sin selección, el botón no inicia nada. Las REQ bloqueadas con estado del portal `Finalizado` no se ejecutan ni manual ni automáticamente, sin eliminarlas de la lista ni borrar sus resultados.
- La casilla de la cabecera de selección, a la izquierda de «Proyecto / Microservicio / REQ», marca o desmarca todas las REQ no bloqueadas, incluso las ocultas por filtros o en otras páginas.
- La tabla muestra «Enviado» (fecha de presentación de la REQ en el portal) y se ordena inicialmente por esa fecha, de la más reciente a la más antigua. Los filtros por proyecto, microservicio, número de REQ, tipo de REQ y estado del portal ofrecen listas compactas de valores disponibles entre las REQ monitoreadas. Los proyectos inferidos comparten la opción del proyecto observado; la fila conserva la marca «inferido» para indicar su origen. Podés escribir parte del texto o recorrer las opciones con las flechas, elegir con Intro y cerrar con Escape; las listas se actualizan con los resultados del tablero. Las REQ bloqueadas aparecen ocultas por defecto; el control permite mostrar todas o solo las bloqueadas sin cambiar su estado. Elegí una fecha (envío, respuesta del usuario, respuesta de Operaciones, revisión o plazo) y pulsá el botón de orden junto a Proyecto, Microservicio u Ordenar por fecha para alternar el sentido en la tabla. Cada botón recuerda su propio sentido para cada fecha; los filtros REQ, Tipo de REQ, Estado del portal y REQ bloqueadas no tienen botón de orden. Las fechas ausentes no se inventan. Ocultar una REQ bloqueada solo afecta la vista: no la desbloquea ni la quita del monitoreo. El contador de resultados incluye las coincidencias de todas las páginas. «Limpiar filtros» vuelve a ocultar las bloqueadas y restablece los filtros dedicados y los de columnas, sin modificar el orden elegido, la selección ni los resultados guardados.
- Al seleccionar o escribir un proyecto, las opciones de Microservicio, REQ y Tipo de REQ se limitan a las REQ monitoreadas de ese proyecto, incluidas las que tienen el proyecto inferido. «Limpiar filtros» restablece todas las opciones. Las selecciones ya escritas en otros filtros no se borran automáticamente.
- Las REQ con respuesta de Operaciones que no están bloqueadas aparecen primero en la tabla, incluso al cambiar el orden o la página. Dentro de ese grupo, y después entre las demás REQ, se conserva el orden elegido; los filtros siguen aplicándose normalmente. Una REQ bloqueada no recibe esta prioridad aunque se muestren todas.
- El navegador del monitor consulta MiAsistencia con la zona horaria de Bogotá (America/Bogota) para que las horas presentadas por el portal coincidan con las que ve el usuario. Los resultados guardados antes de este ajuste conservarán su hora anterior hasta la siguiente consulta; el tablero no altera las horas almacenadas.
- La columna «Conversación» muestra una sola señal por REQ: «Te toca responder» cuando Operaciones respondió y espera al solicitante, o «Ya respondiste» cuando este ya contestó después. Si no hay fechas suficientes para ordenar los comentarios, indica «Orden de mensajes sin confirmar». La columna «Portal» conserva el estado literal y distingue el resultado del cierre. El detalle mantiene el historial completo.
- **Ejecutar todas** selecciona las REQ no bloqueadas y arranca una ejecución manual con un clic. **Ejecutar monitor** conserva la ejecución de solo las REQ seleccionadas.
- El candado en **Acciones** permite bloquear o desbloquear cualquier REQ, incluso sin resultado previo. Las bloqueadas no participan en ejecuciones manuales ni programadas. Para una REQ `Finalizado`, el desbloqueo permite una nueva revisión incluso si sigue con ese estado; si la revisión vuelve a devolver `Finalizado`, se bloquea automáticamente. La fila coloreada identifica la REQ que está en revisión, sin texto adicional junto al número.
- Consultar una REQ específica sin agregarla al monitoreo ni enviar alertas a Teams.
- Descargar adjuntos mediante sesión autenticada del backend, sin abrir enlaces REST expirados.
- Consultar desde `Acceso` si existe una sesión local y ver el usuario ingresado anteriormente, sin exponer contraseña ni cookies. Su presencia no confirma que el portal permita el acceso; `GET /api/auth/status` devuelve únicamente `localSessionAvailable` y `username`.
- Iniciar sesión manualmente desde `Acceso` cuando el portal solicite nuevamente la contraseña. La contraseña se borra del formulario después del intento o al cerrarlo; no se guarda.

Los resultados en `artifacts/monitor-results.json` (o la ruta `--output`) contienen datos personales del solicitante en texto claro. Guarda ese archivo y sus copias solo en almacenamiento local protegido, limita el acceso a la API local (`127.0.0.1`) y no compartas resultados ni capturas del panel. Los detalles abiertos se eliminan del DOM al cerrarlos o al recargar los datos de la tabla; la interfaz actualiza los datos guardados cada 15 segundos y no consulta el portal al hacerlo. Para obtener información nueva del portal, ejecuta el monitor o consulta una REQ manualmente; un campo no observado continúa como no disponible.

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
docker compose up -d --build --wait monitor
docker compose ps
```

Abre `http://127.0.0.1:8787` y agrega las REQ a monitorear desde la interfaz; no necesitas `reqs.txt.example`. Para activar Teams, crea un `.env` local con `TEAMS_WEBHOOK_URL=https://...` antes de iniciar el contenedor. Si el webhook falta, Teams queda desactivado, pero el monitoreo, el dashboard y el guardado de resultados siguen funcionando. Las variables de `.env` se cargan si el archivo existe.

Para actualizar el servicio, ejecuta el mismo comando: reconstruye la imagen con el código actual, recrea el contenedor si cambió y espera a que esté saludable. `runtime`, `artifacts` y `playwright/.auth` permanecen montados fuera de la imagen; no montes archivos fuente ni el bundle sobre `/app`, porque ocultarían el código recién construido. El comando no hace backups automáticos ni desbloquea las REQ finalizadas.

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
