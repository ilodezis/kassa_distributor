// Edits of the managers list made in the "Менеджеры" tab: add / update / bulk edit / delete.
// Pure functions over the config entries, so the rules are testable without a DOM.

import { type ManagerEntry, managerKey } from "./config.ts";
import { cmpStr, normEmail, pyInt, pyStrip } from "./pystr.ts";

export interface EditorForm {
  name: string;
  email: string;
  isSupport: boolean;
  hasCap: boolean;
  capText: string;
}

export type EditResult =
  | { ok: true; managers: ManagerEntry[]; status: string; savedKeys: string[] }
  | { ok: false; message: string };

/** Managers ordered by lowercased name; a stable sort keeps the previous order on ties. */
export function sortManagers(managers: readonly ManagerEntry[]): ManagerEntry[] {
  return managers
    .slice()
    .sort((a, b) => cmpStr(String(a.name ?? "").toLowerCase(), String(b.name ?? "").toLowerCase()));
}

type CapResult = { ok: true; cap: number | null } | { ok: false; message: string };

/** The cap field: required and a positive integer when "Есть cap" is on, ignored otherwise. */
export function parseCapField(hasCap: boolean, capText: string): CapResult {
  if (!hasCap) return { ok: true, cap: null };
  const raw = pyStrip(capText);
  if (raw === "") return { ok: false, message: "Укажи значение cap." };
  try {
    const cap = pyInt(raw);
    if (cap <= 0) throw new Error("not positive");
    return { ok: true, cap };
  } catch {
    return { ok: false, message: "Cap должен быть положительным целым числом." };
  }
}

/**
 * Save button. With several rows selected it applies support / cap to all of them;
 * otherwise it updates the selected entry (or the one with the same email) or adds a new one.
 */
export function saveManager(managers: readonly ManagerEntry[], selectedKeys: ReadonlySet<string>, form: EditorForm): EditResult {
  const capResult = parseCapField(form.hasCap, form.capText);
  if (!capResult.ok) return capResult;
  const cap = capResult.cap;

  if (selectedKeys.size > 1) {
    const next = managers.map((item) =>
      selectedKeys.has(managerKey(item))
        ? { ...item, is_support: form.isSupport, has_cap: form.hasCap, cap: form.hasCap ? cap : null }
        : { ...item },
    );
    return {
      ok: true,
      managers: sortManagers(next),
      status: `Обновлено ${selectedKeys.size} менеджеров`,
      savedKeys: [...selectedKeys],
    };
  }

  const name = pyStrip(form.name);
  const email = normEmail(form.email);
  if (email === "") {
    return { ok: false, message: "Укажи почту менеджера — по ней он ищется в выгрузке." };
  }

  const payload: ManagerEntry = {
    name: name || email,
    email,
    is_support: form.isSupport,
    has_cap: form.hasCap,
    cap: form.hasCap ? cap : null,
  };

  // Update the selected entry (lets a legacy entry without email get one),
  // else the entry with this email, else add a new one.
  let existing = managers.findIndex((item) => selectedKeys.has(managerKey(item)));
  if (existing < 0) existing = managers.findIndex((item) => normEmail(item.email) === email);

  const duplicate = managers.some((item, i) => i !== existing && normEmail(item.email) === email);
  if (duplicate) return { ok: false, message: `Почта ${email} уже есть у другого менеджера.` };

  const next = managers.map((item) => ({ ...item }));
  if (existing >= 0) next[existing] = { ...next[existing]!, ...payload };
  else next.push(payload);

  return { ok: true, managers: sortManagers(next), status: "Менеджер сохранён", savedKeys: [managerKey(payload)] };
}

/** Delete button: removes the entries with the given keys. */
export function deleteManagers(managers: readonly ManagerEntry[], keys: ReadonlySet<string>): ManagerEntry[] {
  return managers.filter((item) => !keys.has(managerKey(item))).map((item) => ({ ...item }));
}
