import { pathsUnder, textOf } from "./files.js";
import { FileError, parseMarkdown } from "./markdown.js";
import { AGENTBOOK, MCP_TOOLSET, TOOLSET } from "./tools.js";

// A scheduled task runs the agent on a timetable, with the same message each time, like "say good
// morning in #gm" every weekday at 8. Each file in scheduled/ is one, named after its file, and it
// becomes a Managed Agents deployment: Anthropic starts each run, so nothing needs to be running here.
export const SCHEDULED_DIR = "scheduled";

const FIELDS = ["schedule", "timezone", "enabled", "budget", "description"];
const MAX_DESCRIPTION = 2048;

// Each part of a cron expression, and the numbers it takes. Day of the week is 0 to 7, where both 0
// and 7 are Sunday.
const CRON_PARTS = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of the month", 1, 31],
  ["month", 1, 12],
  ["day of the week", 0, 7],
];

// Reads scheduled/: each .md file directly inside it is a task named after the file. No scheduled/
// folder means no tasks. Returns { tasks, errors }; a file that can't be parsed has an entry in errors.
export function readScheduled(files) {
  if (SCHEDULED_DIR in files) return { tasks: [], errors: [`${SCHEDULED_DIR}: not a directory`] };

  const tasks = [];
  const errors = [];
  const reportedFolders = new Set();
  for (const file of pathsUnder(files, SCHEDULED_DIR)) {
    const [, item, ...rest] = file.split("/");
    if (rest.length > 0) {
      const folder = `${SCHEDULED_DIR}/${item}`;
      if (!reportedFolders.has(folder)) errors.push(`${folder}: ${SCHEDULED_DIR}/ holds task files, not folders`);
      reportedFolders.add(folder);
    } else if (item.endsWith(".md")) {
      try {
        tasks.push({ file, name: item.slice(0, -".md".length), ...parseMarkdown(textOf(files[file]), file) });
      } catch (err) {
        if (!(err instanceof FileError)) throw err;
        errors.push(err.message);
      }
    }
  }
  return { tasks, errors };
}

// What's wrong with a cron expression, or null. Only the standard five parts are allowed, with
// numbers, ranges, lists, steps and *, which is what Managed Agents accepts.
export function cronProblem(expression) {
  if (typeof expression !== "string") return `must be a cron expression in quotes, like "0 8 * * 1-5"`;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return `must have five parts, for the minute, hour, day of the month, month and day of the week, like "0 8 * * 1-5"`;
  for (const [i, part] of parts.entries()) {
    const [what, min, max] = CRON_PARTS[i];
    for (const item of part.split(",")) {
      const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!match) return `has "${part}" for the ${what}; use numbers, a range like 1-5, a list like 1,3, a step like */15, or *`;
      const [, from, to, step] = match;
      const numbers = [from, to].filter((n) => n !== undefined).map(Number);
      if (numbers.some((n) => n < min || n > max)) return `has "${part}" for the ${what}, which goes from ${min} to ${max}`;
      if (to !== undefined && Number(from) > Number(to)) return `has "${part}" for the ${what}, a range that runs backwards`;
      if (step !== undefined && Number(step) < 1) return `has "${part}" for the ${what}, but a step must be at least 1`;
    }
  }
  return null;
}

// Whether a time zone is one the IANA database knows, like America/Los_Angeles or UTC.
export function isTimeZone(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Errors and warnings for the task files, in check's format. `tools` and `toolsets` are the agent's,
// to warn about tools nobody can answer during a run.
export function checkScheduled(tasks, { tools = [] } = {}, errors = [], warnings = []) {
  const waiting = toolsThatWaitForSomeone(tools);
  for (const task of tasks) {
    const err = (msg) => errors.push(`${task.file}: ${msg}`);
    const { data, body, name } = task;

    // It's the deployment's name, and hosts use it to keep track of the task.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) err("the name may only use lowercase letters, digits, _ and -, up to 64 characters");

    if (data.schedule === undefined) err('`schedule` is required: a cron expression, like "0 8 * * 1-5" for 8 AM on weekdays');
    else {
      const problem = cronProblem(data.schedule);
      if (problem) err(`\`schedule\` ${problem}`);
    }

    if (data.timezone === undefined) err("`timezone` is required, like America/Los_Angeles or UTC");
    else if (!isTimeZone(data.timezone)) err(`\`timezone\` must be a time zone like America/Los_Angeles or UTC, and ${JSON.stringify(data.timezone)} isn't one`);

    if (data.enabled !== undefined && typeof data.enabled !== "boolean") err("`enabled` must be true or false");

    if (data.budget !== undefined && budgetCents(data.budget) === null) err("`budget` must be an amount in US dollars above 0, like 0.50");

    if (data.description !== undefined && data.description !== null) {
      if (typeof data.description !== "string") err("`description` must be text");
      else if (data.description.length > MAX_DESCRIPTION) err(`\`description\` must be at most ${MAX_DESCRIPTION.toLocaleString("en-US")} characters`);
    }

    for (const key of Object.keys(data)) if (!FIELDS.includes(key)) err(`unknown field \`${key}\``);

    if (body.trim() === "") err("the body is empty; it's the message the agent starts each run with");

    if (waiting.length > 0 && data.enabled !== false) {
      warnings.push(`${task.file}: nobody's there to answer during a scheduled run, so a run that calls one of these waits until it's stopped: ${waiting.join(", ")}`);
    }
  }
  return { errors, warnings };
}

// Dollars as the API's minor units, or null if it isn't an amount above 0 with at most two decimals.
function budgetCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return Math.abs(cents - value * 100) < 1e-6 && cents > 0 ? cents : null;
}

// The tools that stop a run until someone answers, which nobody does during a scheduled run: ones set to
// ask first, and custom and agentbook tools, which run wherever the session is being watched from.
function toolsThatWaitForSomeone(tools) {
  const isOn = (row) => row.enabled.toLowerCase() === "true";
  return tools.flatMap((tool) => {
    const type = tool.data.type;
    if (type === TOOLSET) return (tool.rows ?? []).filter((row) => isOn(row) && row.permission === "always_ask").map((row) => row.name);
    if (type === MCP_TOOLSET) {
      const defaults = tool.data.default_config;
      const fallback = defaults?.permission_policy?.type ?? "always_ask";
      if (tool.rows?.length) return tool.rows.filter((row) => isOn(row) && (row.permission || fallback) === "always_ask").map((row) => `${tool.name}.${row.name}`);
      return fallback === "always_ask" && defaults?.enabled !== false ? [`every tool in ${tool.name}`] : [];
    }
    if (type === "custom") return [tool.name];
    if (type === AGENTBOOK) return (tool.rows ?? []).filter(isOn).map((row) => `${tool.name}.${row.name}`);
    return [];
  });
}

// How a task behaves, with the defaults filled in, so that every host agrees on them.
export function taskSettings({ name, data, body }) {
  return {
    name,
    schedule: data.schedule,
    timezone: data.timezone,
    enabled: data.enabled ?? true,
    budgetCents: data.budget === undefined ? null : budgetCents(data.budget),
    description: data.description ?? null,
    message: body,
  };
}

// The parts of a deployment that come from the task's file. Whoever deploys it adds the agent, the
// environment and the vaults.
export function taskBody(task) {
  const { name, schedule, timezone, budgetCents: cents, description, message } = taskSettings(task);
  const body = {
    name,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
    schedule: { type: "cron", expression: schedule.trim(), timezone },
  };
  if (cents !== null) body.budget = { type: "limit", max_list_cost: { amount: String(cents), currency: "USD" } };
  if (description) body.description = description;
  return body;
}

// A task's key in the lock.
export const taskKey = (task) => `./${task.file}`;
