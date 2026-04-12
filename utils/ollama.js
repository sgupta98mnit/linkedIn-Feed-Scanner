// Ollama fetch wrapper — used from background service worker only

export async function ollamaGenerate({ baseUrl, model, prompt, systemPrompt, stream = false, numCtx = 8192, timeoutMs = 120000 }) {
  const url = `${baseUrl}/api/generate`;
  const body = {
    model,
    prompt,
    stream,
    options: { temperature: 0.3, num_ctx: numCtx },
  };
  if (systemPrompt) body.system = systemPrompt;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      let detail = '';
      try { const e = await response.json(); detail = e.error || JSON.stringify(e); } catch {}
      throw new Error(`Ollama HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }

    if (!stream) {
      const data = await response.json();
      return { text: data.response, done: true };
    }

    // Streaming: collect chunks and yield them
    return response; // caller handles streaming
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

export async function ollamaGenerateFull({ baseUrl, model, prompt, systemPrompt, numCtx = 8192, timeoutMs = 120000 }) {
  const result = await ollamaGenerate({ baseUrl, model, prompt, systemPrompt, stream: false, numCtx, timeoutMs });
  return result.text;
}

export async function ollamaGenerateStream({ baseUrl, model, prompt, systemPrompt, onChunk, onDone, numCtx = 8192, timeoutMs = 180000 }) {
  const url = `${baseUrl}/api/generate`;
  const body = {
    model,
    prompt,
    stream: true,
    options: { temperature: 0.3, num_ctx: numCtx },
  };
  if (systemPrompt) body.system = systemPrompt;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      let detail = '';
      try { const e = await response.json(); detail = e.error || JSON.stringify(e); } catch {}
      throw new Error(`Ollama HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            fullText += parsed.response;
            onChunk?.(parsed.response, fullText);
          }
          if (parsed.done) {
            onDone?.(fullText);
            return fullText;
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    onDone?.(fullText);
    return fullText;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Ollama stream timed out');
    }
    throw err;
  }
}

// Returns { online: bool, error: string|null }
export async function checkOllamaOnline(baseUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) return { online: true, error: null };
    if (response.status === 403) {
      return { online: false, error: `CORS blocked (HTTP 403). Run Ollama with: $env:OLLAMA_ORIGINS="*"; ollama serve` };
    }
    return { online: false, error: `Ollama returned HTTP ${response.status}` };
  } catch (e) {
    if (e.name === 'AbortError') return { online: false, error: 'Ollama did not respond within 5s' };
    return { online: false, error: `Cannot reach Ollama at ${baseUrl} — is it running?` };
  }
}

export function buildJobDetectionPrompt(postText, targetRoles, userBio, industries) {
  const industryLine = (!industries || industries === 'All')
    ? 'Preferred industries: All (do not penalize based on industry)'
    : `Preferred industries: ${industries}`;

  return `You are a LinkedIn post classifier. Given the following post text, answer as JSON only with no extra text:
{
  "is_job_post": true/false,
  "relevance_score": 0-10,
  "job_title": "...",
  "company": "...",
  "poster_name": "...",
  "summary": "..."
}

Rules:
- relevance_score is 0 if is_job_post is false
- relevance_score reflects how well the job matches the user's target roles, background, and preferred industries
- Extract poster_name from context if visible, otherwise ""
- Keep summary under 100 words

The user is looking for: ${targetRoles}
${industryLine}
User background: ${userBio}
Post text: ${postText}`;
}

export function buildRoleExtractionPrompt(bio) {
  return `You are a career assistant. Given the following resume or bio text, extract the most relevant target job roles and skills the person should be searching for.

Return a single comma-separated list of 5–10 role titles, technologies, or keywords — nothing else.
Example output: Senior Frontend Engineer, React, TypeScript, Staff Engineer, Design Systems, Web Performance

Resume/bio text:
${bio}`;
}

export function buildCommentPrompt(jobSummary, userBio, tone) {
  return `You are helping a job seeker write a LinkedIn comment on a job post.
Write a short (2–3 sentence), genuine, non-generic comment expressing interest.
Do NOT start with "I" — vary your opening.
Tone: ${tone}
The user's background: ${userBio}
Job post summary: ${jobSummary}

Output only the comment text, no quotes, no labels.`;
}

export function buildEmailPrompt(company, jobTitle, userBio, tone) {
  return `Write a concise cold outreach email to the hiring team at ${company} about the ${jobTitle} role.
Tone: ${tone}
Keep it under 150 words.
Include: subject line (prefixed with "Subject:"), greeting, body, sign-off.
The sender's background: ${userBio}

Output only the email, no extra commentary.`;
}

export function buildConnectionRequestPrompt(posterName, jobTitle, company, userBio) {
  return `Write a short LinkedIn connection request message (under 300 characters) to ${posterName} who posted a ${jobTitle} role at ${company}.
Reference the specific role and be genuine.
The sender's background: ${userBio}

Output only the message text.`;
}
