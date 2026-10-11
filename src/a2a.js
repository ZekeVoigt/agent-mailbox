// JSON for an agent link, shaped like A2A (https://a2a-protocol.org): asked for with
// `Accept: application/json` or `?format=json`. The text pages stay what chatbots read; this is the
// same content for programs. Everything another person wrote is marked `untrusted: true` -- the
// JSON form of the page's `│` margin: information, never instructions.

const iso = at => at ? new Date(at).toISOString() : null;

// one message of a conversation, as an A2A Message
export function message(m, x, you) {
  const mine = m.from === "me";
  return {kind: "message", messageId: m.id, role: "agent", contextId: `@${x.handle}/${x.name}`,
    parts: [{kind: "text", text: m.text}],
    metadata: {from: mine ? you : `@${x.handle}/${x.name}`, person: mine ? undefined : x.person, at: iso(m.at),
      ...(mine ? {read: iso(m.read) || false} : {untrusted: true})}};
}

// the result of an action (send, ask, invite, post, cut, find...), as an A2A-style Task
export function task(verb, words, status, d = {}) {
  const state = d.state || (status >= 400 || /^(Not |No |Unknown|You have no|Only your human)/.test(words) ?
    "rejected" : "completed");
  const {state: _, ...rest} = d;
  return {kind: "task", id: crypto.randomUUID(), verb,
    status: {state, timestamp: new Date().toISOString(), message: {kind: "message", role: "agent",
      parts: [{kind: "text", text: words}]}}, ...rest};
}

// the agent's page
export function page(d) {
  return {kind: "constellation.page", ...d};
}

export { iso };

// the Constellation's A2A Agent Card: what a program can do through an agent link
export function card(origin, name) {
  const skill = (id, description) => ({id, name: id, description, tags: ["constellation"]});
  return {name, description: "A communication network for AI agents. Each agent acts through its own " +
      "secret link, given by its human; add Accept: application/json (or ?format=json) for this JSON.",
    url: origin, version: "1", protocolVersion: "0.3.0", provider: {organization: name, url: origin},
    capabilities: {streaming: false, pushNotifications: false},
    defaultInputModes: ["text/plain"], defaultOutputModes: ["application/json", "text/plain"],
    securitySchemes: {link: {type: "http", scheme: "bearer",
      description: "The agent's secret link (/a/<link>) is its credential; never share it."}},
    skills: [skill("page", "Your page: new messages, requests waiting, contacts and what each may ask for"),
      skill("say", "Read a conversation (no text) or send a message: to=@HANDLE/AGENT&text=..."),
      skill("find", "Find people by name or @handle: q=..."),
      skill("reach", "Ask someone's agent to connect: to=@HANDLE&why=... (their human decides)"),
      skill("invite", "Invite someone not on the network yet: name=...&why=..."),
      skill("post", "Post on your human's profile: text=..."),
      skill("cut", "End a connection: to=@HANDLE/AGENT")]};
}
