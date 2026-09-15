import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BUILTIN_APPS,
  mergeAppRegistries,
  normalizeAliasList,
  normalizeAppName,
} from "./apps.js";

const execFileAsync = promisify(execFile);

const wanted = [
  { id: "opera gx", name: "Opera GX", terms: ["Opera GX"], aliases: ["opera", "opera gx"] },
  { id: "google chrome", name: "Google Chrome", terms: ["Google Chrome", "Chrome"], aliases: ["chrome", "google chrome"] },
  { id: "discord", name: "Discord", terms: ["Discord"], aliases: ["discord"] },
  { id: "steam", name: "Steam", terms: ["Steam"], aliases: ["steam"] },
  { id: "fl studio", name: "FL Studio", terms: ["FL Studio"], aliases: ["fl", "fl studio"] },
  { id: "spotify", name: "Spotify", terms: ["Spotify"], aliases: ["spotify"] },
  { id: "bambu studio", name: "Bambu Studio", terms: ["Bambu Studio"], aliases: ["bambu", "bambu studio"] },
  { id: "visual studio code", name: "Visual Studio Code", terms: ["Visual Studio Code", "VS Code"], aliases: ["vscode", "vs code", "code", "visual studio code"] },
  { id: "audacity", name: "Audacity", terms: ["Audacity"], aliases: ["audacity"] },
];

const ps = String.raw`
$ErrorActionPreference='SilentlyContinue'
$roots=@(
 "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
 "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
$w=New-Object -ComObject WScript.Shell
$out=@()
foreach($root in $roots){
 Get-ChildItem $root -Filter *.lnk -Recurse | ForEach-Object {
  $s=$w.CreateShortcut($_.FullName)
  $out += [pscustomobject]@{
    Name=$_.BaseName
    Target=$s.TargetPath
    Arguments=$s.Arguments
    Shortcut=$_.FullName
  }
 }
}
$out | ConvertTo-Json -Depth 3 -Compress
`;

function parseShortcuts(stdout) {
  try {
    const parsed = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function findShortcut(shortcuts, item) {
  const candidates = shortcuts.filter((shortcut) =>
    item.terms.some((term) =>
      normalizeAppName(shortcut.Name).includes(normalizeAppName(term)),
    ) && shortcut.Shortcut,
  );

  return candidates.sort((a, b) => {
    const exactA = item.terms.some((term) => normalizeAppName(a.Name) === normalizeAppName(term));
    const exactB = item.terms.some((term) => normalizeAppName(b.Name) === normalizeAppName(term));
    if (exactA !== exactB) return exactA ? -1 : 1;
    return String(a.Name).length - String(b.Name).length;
  })[0];
}

const { stdout } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", ps],
  { maxBuffer: 10 * 1024 * 1024 },
);

const shortcuts = parseShortcuts(stdout);
const appsPath = resolve("config", "apps.json");
const existing = JSON.parse(await readFile(appsPath, "utf-8"));
const discovered = {};
const found = [];
const missing = [];

for (const item of wanted) {
  const id = normalizeAppName(item.id);
  if (BUILTIN_APPS[id]) continue;

  const hit = findShortcut(shortcuts, item);

  if (!hit) {
    missing.push(item.id);
    continue;
  }

  discovered[id] = {
    id,
    name: item.name,
    aliases: normalizeAliasList(id, item.aliases),
    source: "start-menu",
    launch: {
      type: "shortcut",
      target: String(hit.Shortcut),
    },
  };

  found.push({
    app: id,
    shortcut: hit.Shortcut,
    target: hit.Target,
    aliases: discovered[id].aliases,
  });
}

const merged = mergeAppRegistries(existing, discovered, BUILTIN_APPS);
await writeFile(appsPath, `${JSON.stringify({
  _comment: "Approved apps. Discovery/path/alias data only. Launch permissions are stored in config/applicationPermissions.json.",
  ...merged,
}, null, 2)}\n`, "utf-8");

console.log("\nDiscovered approved apps:");

for (const item of found) {
  console.log(
    `  OK  ${item.app} -> ${item.shortcut}  [aliases: ${item.aliases.join(", ")}]`,
  );
}

if (missing.length) {
  console.log("\nNot found automatically:");
  for (const item of missing) {
    console.log(`  --  ${item}`);
  }
}

console.log("\nUpdated config/apps.json");
