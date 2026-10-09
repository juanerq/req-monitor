type DeadlineComment = {
  author: string;
  date: string | null;
  text: string;
};

export type CycleComment = DeadlineComment & { isResponse: boolean };

export type CommentCycle<T extends CycleComment> = {
  latestOperationsComment: T | null;
  requesterRepliesAfterOperations: T[];
  activeDeadline: ActiveDeadline | null;
  orderedComments: T[];
  orderKnown: boolean;
};

/** An unordered requester reply cannot safely be classified as still pending. */
export function conversationStatus<T extends CycleComment>(
  cycle: CommentCycle<T>, finalized: boolean, validating: boolean,
): "Finalizada" | "En validación" | "Respondida" | "Pendiente de respuesta" | "Sin comentario de operaciones" {
  if (finalized) return "Finalizada";
  if (validating) return "En validación";
  if (!cycle.latestOperationsComment) return "Sin comentario de operaciones";
  if (!cycle.orderKnown && cycle.orderedComments.some((comment) => !comment.isResponse)) return "Respondida";
  return cycle.requesterRepliesAfterOperations.length > 0 ? "Respondida" : "Pendiente de respuesta";
}

const months: Record<string, number> = {
  ene: 0, jan: 0, feb: 1, mar: 2, abr: 3, apr: 3,
  may: 4, jun: 5, jul: 6, aug: 7, ago: 7,
  sep: 8, oct: 9, nov: 10, dic: 11, dec: 11,
};

/** Parse portal display dates strictly; a guessed sequence could resurrect a stale deadline. */
function commentTime(date: string | null): number | null {
  if (!date) return null;
  const spanish = date.match(/^(\d{1,2})\s+([a-záéíóú]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})$/i);
  const english = date.match(/^([a-z]+)\s+(\d{1,2}),\s+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*([ap])m)?$/i);
  if (!spanish && !english) return null;
  const monthName = (spanish?.[2] ?? english?.[1] ?? "").slice(0, 3).toLowerCase();
  const month = months[monthName];
  const day = Number(spanish?.[1] ?? english?.[2]);
  const year = Number(spanish?.[3] ?? english?.[3]);
  let hour = Number(spanish?.[4] ?? english?.[4]);
  const minute = Number(spanish?.[5] ?? english?.[5]);
  const meridiem = english?.[6]?.toLowerCase();
  if (month === undefined || year < 1993 || day < 1 || day > 31 || minute > 59 ||
    (meridiem ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (meridiem) hour = hour % 12 + (meridiem === "p" ? 12 : 0);
  const value = Date.UTC(year, month, day, hour, minute);
  const parsed = new Date(value);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month && parsed.getUTCDate() === day
    ? value
    : null;
}

export type ActiveDeadline = {
  dueAt: string;
  sourceKey: string;
};

/** Parse only an unambiguous, explicitly stated local deadline; never infer closure. */
export function parseExplicitDeadline(text: string): string | null {
  if (!/\bantes\s+del\s+d[ií]a\b/i.test(text)) return null;

  const dates = [...text.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)];
  if (dates.length !== 1) return null;
  if ([...text.matchAll(/\b\d{1,2}:\d{2}\b/g)].length !== 1) return null;

  const date = dates[0];
  const beforeDate = text.slice(0, date.index);
  if (!/\bantes\s+del\s+d[ií]a\s*[^\dA-Za-z]*$/i.test(beforeDate)) return null;

  const time = text.slice(date.index + date[0].length).match(
    /^[^\dA-Za-z]{0,16}(\d{1,2}):(\d{2})\s*([ap])\s*\.?\s*m\.?(?![\w:])/i,
  );
  if (!time) return null;

  const [day, month, year] = date[0].split("/").map(Number);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (year < 1993 || month < 1 || month > 12 || day < 1 || hour < 1 || hour > 12 || minute > 59) {
    return null;
  }

  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) {
    return null;
  }

  // America/Bogota uses UTC-05:00 without daylight saving time for contemporary dates.
  const localHour = hour % 12 + (time[3].toLowerCase() === "p" ? 12 : 0);
  return new Date(Date.UTC(year, month - 1, day, localHour + 5, minute)).toISOString();
}

/** A requester reply ends the cycle; only a subsequent Operations reply reopens it. */
export function deriveActiveDeadline(
  latestOperationsComment: DeadlineComment | null,
  requesterRepliesAfterOperations: readonly unknown[],
  finalized: boolean,
  occurrence = 0,
): ActiveDeadline | null {
  if (finalized || requesterRepliesAfterOperations.length > 0 || !latestOperationsComment) return null;
  const dueAt = parseExplicitDeadline(latestOperationsComment.text);
  if (!dueAt) return null;

  return {
    dueAt,
    sourceKey: JSON.stringify([
      latestOperationsComment.author,
      latestOperationsComment.date,
      latestOperationsComment.text,
      occurrence,
    ]),
  };
}

/** Normalize portal comment order, retaining DOM order for equal minutes only if direction is established. */
export function deriveCommentCycle<T extends CycleComment>(comments: readonly T[], finalized: boolean): CommentCycle<T> {
  const times = comments.map((comment) => commentTime(comment.date));
  const invalid = times.some((time) => time === null);
  const asc = times.every((time, index) => index === 0 || time! >= times[index - 1]!);
  const desc = times.every((time, index) => index === 0 || time! <= times[index - 1]!);
  const direction = asc && !desc ? "ascending" : desc && !asc ? "descending" : null;
  const entries = comments.map((comment, index) => ({ comment, time: times[index]!, index }));
  const ambiguousTies = new Set(times).size !== times.length;
  if (invalid || (ambiguousTies && !direction)) {
    // A missing timestamp prevents cycle ordering, but does not erase an identified Operations reply.
    // Prefer a dated Operations reply; its identity remains stable when an unrelated date recovers.
    const datedOperations = entries.filter((entry) => entry.comment.isResponse && entry.time !== null);
    const latest = datedOperations.length > 0
      ? datedOperations.reduce((left, right) => right.time > left.time ? right : left).comment
      : comments.find((comment) => comment.isResponse) ?? null;
    return { latestOperationsComment: latest, requesterRepliesAfterOperations: [], activeDeadline: null,
      orderedComments: [...comments], orderKnown: false };
  }

  const ordered = entries.sort((left, right) =>
    left.time - right.time || (direction === "descending" ? right.index - left.index : left.index - right.index),
  );
  const latestIndex = ordered.findLastIndex((entry) => entry.comment.isResponse);
  const latest = latestIndex < 0 ? null : ordered[latestIndex].comment;
  const replies = latestIndex < 0 ? [] : ordered.slice(latestIndex + 1)
    .filter((entry) => !entry.comment.isResponse).map((entry) => entry.comment);
  const occurrence = latest ? ordered.slice(0, latestIndex).filter((entry) =>
    entry.comment.isResponse && entry.comment.author === latest.author &&
    entry.comment.date === latest.date && entry.comment.text === latest.text,
  ).length : 0;
  return {
    latestOperationsComment: latest,
    requesterRepliesAfterOperations: replies,
    activeDeadline: deriveActiveDeadline(latest, replies, finalized, occurrence),
    orderedComments: ordered.map((entry) => entry.comment),
    orderKnown: true,
  };
}
