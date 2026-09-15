import {
  listApplicationsForDiagnostics,
  loadApplicationPermissions,
  loadApps,
} from "../src/apps.js";

const [apps, permissions] = await Promise.all([
  loadApps(),
  loadApplicationPermissions(),
]);

console.table(await listApplicationsForDiagnostics(apps, permissions));
