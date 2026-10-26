  import { env } from "cloudflare:workers";
  import OAuthProvider from "@cloudflare/workers-oauth-provider";
  import { McpServer } from "@modelcontextprotocol/server";
  import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
  import { z } from "zod";
  import { GitHubHandler } from "./github-handler";
  
  type Props = {
  	login: string;
  	name: string;
  	email: string;
  	accessToken: string;
  };
  
  // Only these GitHub usernames can use the bridge
  const ALLOWED_USERNAMES = new Set<string>(["amudyabuky-svg"]);
  
  const MAX_LEN = 4000;
  
  function splitMessage(text: string): string[] {
  	if (text.length <= MAX_LEN) return [text];
  	const parts: string[] = [];
  	let current = "";
  	for (const line of text.split("\n")) {
  		let rest = line;
  		while (rest.length > MAX_LEN) {
  			if (current) {
  				parts.push(current);
  				current = "";
  			}
  			parts.push(rest.slice(0, MAX_LEN));
  			rest = rest.slice(MAX_LEN);
  		}
  		const candidate = current ? current + "\n" + rest : rest;
  		if (candidate.length > MAX_LEN) {
  			parts.push(current);
  			current = rest;
  		} else {
  			current = candidate;
  		}
  	}
  	if (current) parts.push(current);
  	return parts;
  }
  
  async function sendPart(text: string): Promise<number> {
  	const token = (env as any).TELEGRAM_BOT_TOKEN as string;
  	const chatId = (env as any).TELEGRAM_CHAT_ID as string;
  	if (!token || !chatId) {
  		throw new Error("Telegram secrets are not set on the server.");
  	}
  	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  		method: "POST",
  		headers: { "Content-Type": "application/json" },
  		body: JSON.stringify({ chat_id: chatId, text }),
  	});
  	const data = (await res.json()) as {
  		ok: boolean;
  		description?: string;
  		result?: { message_id: number };
  	};
  	if (!data.ok || !data.result) {
  		throw new Error(`Telegram error: ${data.description ?? res.status}`);
  	}
  	return data.result.message_id;
  }
  
  function createServer() {
  	const server = new McpServer({
  		name: "Telegram Bridge",
  		version: "1.0.0",
  	});
  	const props = getMcpAuthContext()?.props as Props | undefined;
  
  	if (!props || !ALLOWED_USERNAMES.has(props.login)) {
  		return server;
  	}
  
  	server.registerTool(
  		"ping",
  		{
  			description: "Check the bridge is working. Sends nothing.",
  		},
  		async () => ({
  			content: [{ type: "text", text: `ok ${new Date().toISOString()}` }],
  		}),
  	);
  
  	server.registerTool(
  		"send_to_telegram",
  		{
  			description: "Send a plain text message to the owner's Telegram chat.",
  			inputSchema: z.object({
  				text: z.string().min(1).describe("The message to send."),
  			}),
  		},
  		async ({ text }) => {
  			try {
  				const ids: number[] = [];
  				for (const part of splitMessage(text)) {
  					ids.push(await sendPart(part));
  				}
  				console.log(
  					JSON.stringify({ event: "send", length: text.length, parts: ids.length, ok: true }),
  				);
  				return {
  					content: [{ type: "text", text: `Sent. message_id: ${ids.join(", ")}` }],
  				};
  			} catch (err) {
  				const msg = err instanceof Error ? err.message : "Unknown error";
  				console.log(JSON.stringify({ event: "send", length: text.length, ok: false }));
  				return {
  					isError: true,
  					content: [{ type: "text", text: msg }],
  				};
  			}
  		},
  	);
  
  	return server;
  }
  
  const mcpHandler = createMcpHandler(createServer);
  const apiHandler = {
  	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
  		return mcpHandler(request, bindings, ctx);
  	},
  } satisfies ExportedHandler<Env>;
  
  export default new OAuthProvider({
  	allowPlainPKCE: false,
  	apiHandler,
  	apiRoute: "/mcp",
  	authorizeEndpoint: "/authorize",
  	clientRegistrationEndpoint: "/register",
  	defaultHandler: GitHubHandler as any,
  	tokenEndpoint: "/token",
  });
