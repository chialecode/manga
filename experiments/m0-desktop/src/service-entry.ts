import { serveIpc } from "../../m0/src/hosts/ipc-server.ts";
const index = process.argv.indexOf("--profile");
if (index < 0 || !process.argv[index + 1]) throw new Error("missing profile");
process.env.M0_PARSE_WORKER ??= "1";
serveIpc(process.argv[index + 1]!, "desktop-host").catch(error => { console.error(error); process.exitCode = 1; });
