import { parseVerifySpec } from "./index.js";
import { sameSite } from "../interface/sources.js";

// `test` found no verify_call in alg.yml and none in the product's docs. Instead of stopping, it asks the person
// at the terminal for the call, or lets them skip the check. ask(question) returns the typed line; say(line)
// prints one. Returns { call, header, apiHost, offSite } for a call, or { skip: true }.

export const EXAMPLE_CALL = "GET https://api.example.com/v1/me";
export const DEFAULT_HEADER = "Authorization: Bearer {key}";

export async function askVerifyCall({ ask, say, url, reason, style }) {
  const dim = style?.dim || ((s) => s);
  const bold = style?.bold || ((s) => s);
  say("");
  say(`  We couldn't find an OpenAPI spec to figure out how to test your API key${reason ? ` ${dim(`(${reason})`)}` : ""}.`);
  say("  What's a simple GET endpoint we can use to verify the key works?");
  say(`  ${dim(`e.g. ${EXAMPLE_CALL}. Press Enter with nothing to skip verification: the agent signs up, and its key is not checked.`)}`);
  let spec;
  for (;;) {
    const reply = (await ask("  Call: ")).trim();
    if (!reply || /^skip$/i.test(reply)) return { skip: true };
    spec = parseVerifySpec({ verify_call: reply });
    if (!spec.error) break;
    say(`  ${spec.error.replace(/^alg\.yml has no verify_call\. /, "")}`);
  }
  const call = `${spec.method} ${spec.url}`;
  let header;
  for (;;) {
    const reply = (await ask(`  Header that carries the key ${dim(`[${DEFAULT_HEADER}]`)}: `)).trim() || DEFAULT_HEADER;
    const withHeader = parseVerifySpec({ verify_call: call, verify_header: reply });
    if (!withHeader.error) {
      header = reply;
      break;
    }
    say(`  ${withHeader.error}`);
  }
  const apiHost = new URL(spec.url.replace(/\{[^}]+\}/g, "x")).hostname;
  const offSite = !sameSite(spec.url, url);
  say(`  ${dim("Will check with")} ${bold(call)} ${dim(`(${header})`)}`);
  return { call, header, apiHost, offSite };
}
