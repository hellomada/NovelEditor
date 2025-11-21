import React, { useState, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

export default function App() {
  const [view, setView] = useState("landing");
  const [apiKey, setApiKey] = useState("");
  const [rawText, setRawText] = useState("");
  const [filename, setFilename] = useState("");
  const [pages, setPages] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [responseText, setResponseText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [allowMajor, setAllowMajor] = useState(false);
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

  function wordCount(s) {
    if (!s) return 0;
    return s.trim().split(/\s+/).filter(Boolean).length;
  }

  // --- Prompt enhancement ---
  async function enhancePrompt(userPrompt) {
    if (!userPrompt) return userPrompt;
    const messages = [
      {
        role: "system",
        content:
          "You are a prompt improvement assistant. Make the user's prompt as clear, detailed, and direct as possible for an AI editor, without changing its intended goal.",
      },
      { role: "user", content: userPrompt },
    ];
    const enhanced = await callOpenAI(messages);
    return enhanced || userPrompt;
  }

  function buildMessages(documentText, userPrompt, allowMajorRewriteFlag) {
    const system = `
You are AUTHORKEEPER — an editing assistant that preserves an author's original voice, structure, pacing, and content unless the author explicitly allows major rewrites. 

RULES (MUST FOLLOW):
1) Apply ONLY the user's requested changes.
2) Do NOT summarize, shorten, or remove content unless ALLOW_MAJOR_REWRITE is YES.
3) Preserve paragraph order, character names, plot beats, and unique voice.
4) Warn if edit shortens >10% unless allowed.
5) Return ONLY the edited text — no commentary or annotations.
6) Structural changes only if explicitly requested in major rewrite.

Return a single block of the edited document exactly as requested.
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
Apply only the requested changes. Preserve voice, structure, and length unless ALLOW_MAJOR_REWRITE is YES. Return only the edited text.`,
      },
    ];
  }

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
          max_tokens: 12000,
          temperature: 0.15,
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

  async function processDocumentWithSafety(documentText, userPrompt, allowMajorRewriteFlag) {
    setError("");
    setResponseText("");

    const totalWords = wordCount(documentText);
    setLastRequestWordCount(totalWords);

    const enhancedPrompt = await enhancePrompt(userPrompt);

    const chunks = splitIntoChunksByWords(documentText, 3500);
    const outputs = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkDoc =
        chunks.length > 1 ? `<<CHUNK ${i + 1} of ${chunks.length}>>\n\n${chunks[i]}` : chunks[i];
      const messages = buildMessages(chunkDoc, enhancedPrompt, allowMajorRewriteFlag);
      const out = await callOpenAI(messages);
      if (out === null) return null;
      outputs.push(out);
    }

    const combined = outputs.join("\n\n");
    const outWords = wordCount(combined);

    if (!allowMajorRewriteFlag && outWords < totalWords * 0.9) {
      setError(
        "AI output is significantly shorter than the original (>10%). Check 'Allow major rewrites' to permit."
      );
      return null;
    }

    return combined;
  }

  async function handleRun() {
    setError("");
    setResponseText("");

    if (!rawText) {
      setError("No document text provided.");
      return;
    }
    if (!prompt) {
      setError("Please enter a prompt.");
      return;
    }

    const out = await processDocumentWithSafety(rawText, prompt, allowMajor);
    if (out) setResponseText(out);
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

  function handleReviseOutput() {
    if (!responseText) return;
    setRawText(responseText);
    setPrompt("");
    setResponseText("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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
        {/* --- Landing UI --- */}
        {view === "landing" && (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center rounded-xl bg-white shadow p-8">
            <div>
              <h1 className="text-3xl font-bold leading-snug">
                AuthorMate — The gentle editor for your voice
              </h1>
              <p className="mt-4 text-gray-700">
                Keep every nuance. Fix grammar and flow. Preserve tone, structure, and meaning. Only apply the changes the author asked for — unless they explicitly allow larger rewrites.
              </p>
              <ul className="mt-6 text-gray-700 space-y-2">
                <li>• Upload up to 15 pages (PDF or paste)</li>
                <li>• Strict "author-first" editing: no surprises</li>
                <li>• Revise mode to iterate safely</li>
                <li>• Share a link after deployment</li>
              </ul>
              <div className="mt-6 flex gap-3">
                <button onClick={() => setView("editor")} className="bg-pink-500 text-white px-4 py-2 rounded shadow">
                  Start Editing
                </button>
                <a
                  href="https://platform.openai.com/settings/organization/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="px-4 py-2 rounded border text-gray-700"
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
              <textarea
                rows={10}
                className="w-full mt-2 p-3 border rounded"
                placeholder="Paste a short sample and write a prompt..."
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setPages(Math.ceil(e.target.value.length / 2000));
                }}
              />
              <div className="mt-3 flex gap-2">
                <button onClick={() => setView("editor")} className="bg-gray-900 text-white px-3 py-2 rounded">
                  Open Editor
                </button>
                <button
                  onClick={() => {
                    setPrompt(
                      "Fix grammar and flow. Preserve tone and length. Return only the edited text."
                    );
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

        {/* --- Editor UI --- */}
        {view === "editor" && (
          <section className="mt-6 bg-white rounded-xl shadow p-6 space-y-6">
            <div className="flex flex-col md:flex-row md:items-center md:gap-4">
              <input
                type="text"
                placeholder="Your OpenAI API Key"
                className="flex-1 border p-2 rounded"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button onClick={handleClear} className="bg-gray-200 px-3 py-2 rounded">
                Clear All
              </button>
            </div>

            <div>
              <label className="block mb-1 font-semibold">Upload PDF or Text File (≤15 pages)</label>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="mb-2" />
              <textarea
                rows={12}
                className="w-full p-3 border rounded"
                placeholder="Or paste your text here..."
                value={rawText}
                onChange={handlePasteTextChange}
              />
              {filename && <div className="text-sm text-gray-500 mt-1">Filename: {filename}</div>}
              {pages > 0 && <div className="text-sm text-gray-500">Estimated pages: {pages}</div>}
            </div>

            <div>
              <label className="block mb-1 font-semibold">Prompt / Instructions</label>
              <textarea
                rows={4}
                className="w-full p-3 border rounded"
                placeholder="Enter editing instructions..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={allowMajor} onChange={(e) => setAllowMajor(e.target.checked)} />
                Allow major rewrites
              </label>
              <button
                onClick={handleRun}
                className="bg-pink-500 text-white px-4 py-2 rounded shadow"
                disabled={loading}
              >
                {loading ? "Running..." : "Run AI"}
              </button>
              <button onClick={handleReviseOutput} className="bg-gray-200 px-3 py-2 rounded">
                Revise Output
              </button>
              {responseText && (
                <button onClick={() => downloadText("edited.txt", responseText)} className="bg-green-500 text-white px-3 py-2 rounded">
                  Download
                </button>
              )}
            </div>

            {error && <div className="text-red-600 font-semibold">{error}</div>}

            {responseText && (
              <div>
                <label className="block mb-1 font-semibold">AI Output</label>
                <textarea rows={12} className="w-full p-3 border rounded bg-gray-50" value={responseText} readOnly />
              </div>
            )}
          </section>
        )}

        <section className="mt-8 text-center text-xs text-gray-500">
          AuthorMate — built with care ❤️ • Made for Lilou
        </section>
      </main>
    </div>
  );
}
