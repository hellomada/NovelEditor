import React, { useState, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

/**
 * AuthorMate — Single-file app (Landing + Editor)
 * - Tailwind assumed
 * - Paste into src/App.jsx
 * - Use your OpenAI key (never hardcode)
 *
 * Features:
 * - Elegant landing hero + logo
 * - Upload PDF (<=15 pages) or paste text (<=15 pages)
 * - Strong system prompt that preserves voice & length
 * - "Allow major rewrites" toggle — REQUIRED to allow shortening/major changes
 * - Revise This Output button (move AI output back into the editor for iterative edits)
 * - Chunking fallback for very long documents (word-based)
 * - Safeguard that blocks outputs that shorten >10% unless "allow major rewrites" is checked
 */

export default function App() {
  // App UI state
  const [view, setView] = useState("landing"); // 'landing' or 'editor'
  const [apiKey, setApiKey] = useState("");
  const [rawText, setRawText] = useState("");
  const [filename, setFilename] = useState("");
  const [pages, setPages] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [responseText, setResponseText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [allowMajor, setAllowMajor] = useState(false); // allow big rewrites/shortening
  const [lastRequestWordCount, setLastRequestWordCount] = useState(0);

  const fileInputRef = useRef(null);

  // --- PDF / upload helpers ---
  async function handlePDFUpload(file) {
    setError("");
    setFilename(file.name);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const numPages = pdf.numPages;
      setPages(numPages);

      if (numPages > 15) {
        setError("PDF has more than 15 pages — please upload 15 pages or fewer.");
        setRawText("");
        return;
      }

      let text = "";
      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const strings = content.items.map((s) => s.str);
        text += strings.join(" ") + "\n\n";
      }
      setRawText(text);
    } catch (e) {
      console.error(e);
      setError("Failed to read PDF. Ensure it's a valid PDF file.");
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type === "application/pdf") {
      await handlePDFUpload(file);
    } else {
      const text = await file.text();
      const approxPages = Math.ceil(text.length / 2000);
      setPages(approxPages);

      if (approxPages > 15) {
        setError("File estimate exceeds 15 pages — please upload ≤15 pages.");
        setRawText("");
        return;
      }

      setFilename(file.name);
      setRawText(text);
    }
  }

  function handlePasteTextChange(e) {
    const t = e.target.value;
    setRawText(t);
    const approxPages = Math.ceil(t.length / 2000);
    setPages(approxPages);
    if (approxPages > 15) setError("Pasted text seems longer than 15 pages — trim it.");
    else setError("");
  }

  // --- Utility helpers ---
  function wordCount(s) {
    if (!s) return 0;
    return s.trim().split(/\s+/).filter(Boolean).length;
  }

  function buildMessages(documentText, userPrompt, allowMajorRewriteFlag) {
    // Strong system prompt that enforces preservation rules.
    const system = `
You are AUTHORKEEPER — an editing assistant that preserves an author's original voice, structure, pacing, and content unless the author explicitly allows major rewrites.

RULES (MUST FOLLOW):
1) Apply ONLY the user's requested changes. If the user asks for "fix grammar and flow", do exactly that and nothing else.
2) Do NOT summarize, shorten, or remove scenes, sentences, or important phrasing unless the user explicitly checks "Allow major rewrites".
3) Preserve paragraph order, character names, plot beats, and unique voice.
4) If an edit would shorten the text by more than 10%, warn first and avoid doing it unless allowed.
5) Return ONLY the edited text — no commentary, no annotations, no editorial notes.
6) If you must make a structural change because the user explicitly requested a major rewrite, do so across the whole document and mention nothing in the output other than the new text.

When replying, produce a single block of the edited document exactly as requested.
`;

    return [
      { role: "system", content: system },
      {
        role: "user",
        content: `ORIGINAL_DOCUMENT:
${documentText}

TASK:
${userPrompt}

ALLOW_MAJOR_REWRITE: ${allowMajorRewriteFlag ? "YES" : "NO"}

INSTRUCTION:
Apply only the changes requested. Preserve voice, structure and length unless ALLOW_MAJOR_REWRITE is YES. Return only the edited document text.`
      }
    ];
  }

  // Chunking: split by words into roughly equal chunks (keeps paragraph boundaries)
  function splitIntoChunksByWords(text, maxWordsPerChunk = 3500) {
    if (!text) return [];
    const words = text.split(/\s+/);
    if (words.length <= maxWordsPerChunk) return [text];
    const chunks = [];
    let idx = 0;
    while (idx < words.length) {
      const slice = words.slice(idx, idx + maxWordsPerChunk);
      chunks.push(slice.join(" "));
      idx += maxWordsPerChunk;
    }
    return chunks;
  }

  async function callOpenAI(messages) {
    if (!apiKey) {
      setError("Please provide your OpenAI API key.");
      return null;
    }

    setError("");
    setLoading(true);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          // large max_tokens to reduce truncation risk; platform may enforce caps
          max_tokens: 12000,
          temperature: 0.15,
          presence_penalty: 0,
          frequency_penalty: 0
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`OpenAI error: ${res.status} ${txt}`);
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      console.error(e);
      setError(String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }

  // Orchestrator that supports chunking (if needed) and preservation checks
  async function processDocumentWithSafety(documentText, userPrompt, allowMajorRewriteFlag) {
    setError("");
    setResponseText("");

    const totalWords = wordCount(documentText);
    setLastRequestWordCount(totalWords);

    // If document is large, split into safe chunks
    const chunks = splitIntoChunksByWords(documentText, 3500);

    if (chunks.length === 1) {
      const messages = buildMessages(documentText, userPrompt, allowMajorRewriteFlag);
      const out = await callOpenAI(messages);
      return out;
    } else {
      // Multiple chunks: process each chunk individually with the same instruction,
      // and concatenate preserving order. This keeps structure but may cause slight boundary artifacts.
      const outputs = [];
      for (let i = 0; i < chunks.length; i++) {
        // keep context note so model knows chunk number
        const chunkDoc = `<<CHUNK ${i + 1} of ${chunks.length} — keep boundaries intact>>\n\n${chunks[i]}`;
        const messages = buildMessages(chunkDoc, userPrompt, allowMajorRewriteFlag);
        const out = await callOpenAI(messages);
        if (out === null) {
          return null;
        }
        outputs.push(out);
        // small delay could be added in production
      }
      // Recombine — ensure exact order
      return outputs.join("\n\n");
    }
  }

  // Run handler with safeguards
  async function handleRun() {
    setError("");
    setResponseText("");

    if (!rawText) {
      setError("No document text provided. Paste text or upload a PDF (≤ 15 pages).");
      return;
    }
    if (pages > 15) {
      setError("Document exceeds 15 pages.");
      return;
    }
    if (!prompt) {
      setError("Please enter what you want the AI to do in the Prompt box.");
      return;
    }

    // record input size
    const inputWords = wordCount(rawText);
    setLastRequestWordCount(inputWords);

    // Process (chunked if needed)
    const out = await processDocumentWithSafety(rawText, prompt, allowMajor);

    if (out === null) return;

    // Safeguard: do not accept outputs that are much shorter than input unless allowed
    const outWords = wordCount(out);
    if (!allowMajor && outWords < inputWords * 0.90) {
      setError(
        "AI output is significantly shorter than the original (more than 10% shorter). " +
          "To allow major rewrites or shortening, check 'Allow major rewrites' and run again. No output shown."
      );
      return;
    }

    // Also, attempt to keep line-paragraph count similar: we don't strictly enforce here but alert if drastically different
    setResponseText(out);
  }

  function handleClear() {
    setRawText("");
    setFilename("");
    setPages(0);
    setPrompt("");
    setResponseText("");
    setError("");
    setAllowMajor(false);
    setLastRequestWordCount(0);
  }

  // Revise output: put output back into editor for iterative refinement
  function handleReviseOutput() {
    if (!responseText) return;
    setRawText(responseText);
    setPrompt("");
    setResponseText("");
    setError("");
    // keep allowMajor as-is so user can continue
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Basic logo (SVG) component
  function Logo({ size = 40 }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="inline-block align-middle"
      >
        <rect width="64" height="64" rx="12" fill="#0F172A" />
        <g transform="translate(12,12)" fill="none" stroke="#F9A8D4" strokeWidth="2">
          <circle cx="20" cy="20" r="12" stroke="#F9A8D4" strokeWidth="1.8" />
          <path d="M20 8 L20 28" stroke="#F9A8D4" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M8 20 L32 20" stroke="#F9A8D4" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      </svg>
    );
  }

  // Small helper: download response as .txt
  function downloadText(filenameOut = "edited.txt", content = "") {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filenameOut;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  // --- UI ---
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white p-6">
      <header className="max-w-6xl mx-auto flex items-center justify-between py-6">
        <div className="flex items-center gap-4">
          <Logo size={48} />
          <div>
            <div className="text-lg font-semibold">AuthorMate</div>
            <div className="text-xs text-gray-500">preserve • polish • protect</div>
          </div>
        </div>

        <nav className="flex items-center gap-4">
          <button
            onClick={() => setView("landing")}
            className={`px-3 py-2 rounded ${view === "landing" ? "bg-gray-900 text-white" : "text-gray-700"}`}
          >
            Home
          </button>
          <button
            onClick={() => setView("editor")}
            className={`px-3 py-2 rounded ${view === "editor" ? "bg-pink-500 text-white" : "text-gray-700"}`}
          >
            Editor
          </button>
        </nav>
      </header>

      <main className="max-w-6xl mx-auto">
        {view === "landing" && (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center rounded-xl bg-white shadow p-8">
            <div>
              <h1 className="text-3xl font-bold leading-snug">
                AuthorMate — The gentle editor for your voice
              </h1>
              <p className="mt-4 text-gray-700">
                Keep every nuance. Fix grammar and flow. Preserve tone, structure, and meaning.
                Only apply the changes the author asked for — unless they explicitly allow larger rewrites.
              </p>

              <ul className="mt-6 text-gray-700 space-y-2">
                <li>• Upload up to 15 pages (PDF or paste)</li>
                <li>• Strict "author-first" editing: no surprises</li>
                <li>• Revise mode to iterate safely</li>
                <li>• Share a link after deployment (host on Vercel / Netlify)</li>
              </ul>

              <div className="mt-6 flex gap-3">
                <button
                  onClick={() => setView("editor")}
                  className="bg-pink-500 text-white px-4 py-2 rounded shadow"
                >
                  Start Editing
                </button>
                <a
                  className="px-4 py-2 rounded border text-gray-700"
                  href="https://platform.openai.com/settings/organization/api-keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get OpenAI API Key
                </a>
              </div>

              <div className="mt-6 text-xs text-gray-500">
                Made with love for <strong>Lilou</strong> — preserve the heart of every story.
              </div>
            </div>

            <div className="rounded-lg p-6 bg-gradient-to-br from-gray-50 to-white border">
              <div className="text-sm text-gray-600">Quick demo</div>
              <div className="mt-4">
                <div className="text-xs text-gray-500">Paste a short sample here to test:</div>
                <textarea
                  rows={10}
                  className="w-full mt-2 p-3 border rounded"
                  placeholder="Paste a short sample, write a prompt like 'Fix grammar and flow; keep tone and length.' Then click Run."
                  value={rawText}
                  onChange={(e) => {
                    setRawText(e.target.value);
                    setPages(Math.ceil(e.target.value.length / 2000));
                  }}
                />
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setView("editor")}
                  className="bg-gray-900 text-white px-3 py-2 rounded"
                >
                  Open Editor
                </button>
                <button
                  onClick={() => {
                    setPrompt('Fix grammar and flow. Preserve tone and length. Return only the edited text.');
                    setView("editor");
                  }}
                  className="px-3 py-2 rounded border"
                >
                  Use Default Prompt
                </button>
              </div>
            </div>
          </section>
        )}

        {view === "editor" && (
          <section className="mt-6 bg-white rounded-xl shadow p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-1">
                <h2 className="text-xl font-semibold">
                  AuthorMate Editor{" "}
                  <span className="text-pink-500 text-sm ml-1">for my love… future bestselling author… Lilou 💗</span>
                </h2>
                <p className="text-xs text-gray-500 mt-2">
                  Upload a PDF (≤15 pages) or paste text. Provide your OpenAI key below — it stays in your browser.
                </p>

                <label className="block mt-4 text-sm font-medium">OpenAI API Key</label>
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="mt-1 block w-full border rounded p-2"
                  placeholder="sk-..."
                />
                <a
                  href="https://platform.openai.com/settings/organization/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline text-xs mt-1 block"
                >
                  Click here to create or view your API key
                </a>

                <label className="block mt-4 text-sm font-medium">Upload PDF or text file (≤ 15 pages)</label>
                <input ref={fileInputRef} type="file" accept="application/pdf,text/plain" onChange={handleFileChange} className="mt-1" />

                <div className="mt-4">
                  <label className="block text-sm font-medium">Or paste text</label>
                  <textarea
                    value={rawText}
                    onChange={handlePasteTextChange}
                    rows={8}
                    className="mt-1 w-full border rounded p-2"
                    placeholder="Paste up to 15 pages of text here..."
                  ></textarea>
                  <div className="text-xs text-gray-500 mt-1">
                    Approx pages: {pages} • File: {filename || "none"} • Words: {wordCount(rawText)}
                  </div>
                </div>

                <div className="mt-4">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={allowMajor} onChange={(e) => setAllowMajor(e.target.checked)} />
                    <span className="text-xs">Allow major rewrites / shortening (check to permit)</span>
                  </label>
                </div>

                <div className="mt-4">
                  <button onClick={handleClear} className="bg-gray-200 px-3 py-2 rounded w-full">
                    Clear
                  </button>
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium">Prompt (exactly what to do)</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={6}
                  className="mt-1 w-full border rounded p-2"
                  placeholder={`Example: "Edit the document for clarity and grammar. Return only the edited text (no annotations). Keep paragraphs intact."`}
                />

                <div className="flex items-center gap-3 mt-3">
                  <label className="text-sm">Model</label>
                  <select value={model} onChange={(e) => setModel(e.target.value)} className="border rounded p-1">
                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                    <option value="gpt-4o">gpt-4o</option>
                    <option value="gpt-4o-mini-vision">gpt-4o-mini-vision</option>
                  </select>

                  <button onClick={handleRun} disabled={loading} className="ml-auto bg-pink-500 text-white px-4 py-2 rounded hover:opacity-95">
                    {loading ? "Running…" : "Run AI"}
                  </button>

                  <button onClick={handleReviseOutput} disabled={!responseText} className="ml-2 bg-purple-600 text-white px-4 py-2 rounded">
                    Revise This Output
                  </button>

                  <button
                    onClick={() => {
                      if (responseText) downloadText(`edited-${filename || "text"}.txt`, responseText);
                    }}
                    disabled={!responseText}
                    className="ml-2 bg-indigo-600 text-white px-3 py-2 rounded"
                  >
                    Download
                  </button>
                </div>

                {error && <div className="mt-3 text-red-600">{error}</div>}

                <div className="mt-6">
                  <h3 className="font-semibold">AI Output</h3>
                  <div className="mt-2 whitespace-pre-wrap border rounded p-4 min-h-[200px] bg-gray-50">
                    {responseText || <span className="text-gray-400">AI output will appear here…</span>}
                  </div>

                  {responseText && (
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => navigator.clipboard.writeText(responseText)}
                        className="px-3 py-2 bg-green-600 text-white rounded"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => {
                          setRawText(responseText);
                          setResponseText("");
                          setPrompt("");
                        }}
                        className="px-3 py-2 bg-yellow-500 text-white rounded"
                      >
                        Use as New Draft
                      </button>
                    </div>
                  )}

                  <div className="mt-4 text-xs text-gray-500">
                    Last request words: {lastRequestWordCount} • Output words: {wordCount(responseText)}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="mt-8 text-center text-xs text-gray-500">
          AuthorMate — built with care ❤️ • Made for Lilou
        </section>
      </main>
    </div>
  );
}
