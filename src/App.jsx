import React, { useState, useRef } from "react";

/**
 * AuthorMate — single-file React component
 * - Tailwind CSS expected
 * - Uses pdfjs-dist to extract text from PDFs in the browser
 * - Sends the user's prompt + document text to OpenAI Chat Completions API
 * - Enforces a 15-page-per-upload limit for PDFs
 * - Requires the user to paste/provide their own OpenAI API key (never hardcode keys)
 *
 * Install (example):
 * npm install react pdfjs-dist
 * (Tailwind must be set up in your project separately)
 *
 * NOTE: This component demonstrates client-side usage for development or private local use.
 * In production you should route requests through a backend to keep your API key secret and to
 * enforce usage limits and monitoring. Also be mindful of costs: OpenAI requests are not free.
 */

// Minimal helper to extract text and page count from PDF using pdfjs-dist
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
// pdfjs-dist needs a worker; for CRA or Vite you may need to import worker separately.
// import pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.entry';
// pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export default function AuthorMate() {
  const [apiKey, setApiKey] = useState("");
  const [rawText, setRawText] = useState("");
  const [filename, setFilename] = useState("");
  const [pages, setPages] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [responseText, setResponseText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loveMsgEnabled, setLoveMsgEnabled] = useState(true);
  const [loveMsg, setLoveMsg] = useState("My love, this book is so special — please be gentle but honest when editing.\nTone: kind, encouraging, and clear.");

  const fileInputRef = useRef(null);

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
      // extract text from each page
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
      setError("Failed to read PDF. Make sure it's a valid PDF file.");
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type === "application/pdf") {
      await handlePDFUpload(file);
    } else {
      // try to read as text
      const text = await file.text();
      const approxPages = Math.ceil(text.length / 2000); // rough estimate
      setPages(approxPages);
      if (approxPages > 15) {
        setError("File estimate exceeds 15 pages — please upload <= 15 pages.");
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
    if (approxPages > 15) setError("Pasted text seems longer than 15 pages — trim it down.");
    else setError("");
  }

  function buildMessages(documentText, userPrompt, includeLove) {
    // Strong system instruction to try to make the model output ONLY what user asked for.
    const system = `You are a precise assistant for authors. Follow the user's instructions exactly and only — do not add commentary, explanations, apologies, or any extra content beyond the user's requested output. If the user asks for edited text, return only the edited text. If the user asks for a short note or a rewritten paragraph, return only that. Keep answers concise.`;

    let messages = [
      { role: "system", content: system },
    ];

    let combinedUser = "";
    if (includeLove) {
      combinedUser += `LOVE MESSAGE (for context):\n${loveMsg}\n\n`;
    }
    combinedUser += `DOCUMENT:\n${documentText}\n\nUSER INSTRUCTION:\n${userPrompt}`;

    messages.push({ role: "user", content: combinedUser });
    return messages;
  }

  async function callOpenAI(messages) {
    if (!apiKey) {
      setError("Please provide your OpenAI API key.");
      return null;
    }
    setError("");
    setLoading(true);
    setResponseText("");
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 3000,
          temperature: 0.2,
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`OpenAI error: ${res.status} ${txt}`);
      }
      const data = await res.json();
      const assistantMsg = data.choices?.[0]?.message?.content ?? "";
      return assistantMsg;
    } catch (e) {
      console.error(e);
      setError(String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleRun() {
    setResponseText("");
    setError("");
    if (!rawText) {
      setError("No document text provided. Paste text or upload a PDF (<= 15 pages).\n");
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
    const messages = buildMessages(rawText, prompt, loveMsgEnabled);
    const out = await callOpenAI(messages);
    if (out !== null) {
      setResponseText(out);
    }
  }

  function handleClear() {
    setRawText("");
    setFilename("");
    setPages(0);
    setPrompt("");
    setResponseText("");
    setError("");
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto bg-white rounded-2xl shadow p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <h1 className="text-2xl font-bold">AuthorMate — Edit Assistant</h1>
          <p className="mt-2 text-sm text-gray-600">Upload a PDF (≤15 pages) or paste text. Provide your OpenAI key below — it stays in your browser (do not share). This demo uses the Chat Completions API.</p>

          <label className="block mt-4 text-sm font-medium">OpenAI API Key</label>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="mt-1 block w-full border rounded p-2"
            placeholder="sk-..."
          />

          <label className="block mt-4 text-sm font-medium">Upload PDF or text file (≤ 15 pages)</label>
          <input ref={fileInputRef} type="file" accept="application/pdf,text/plain" onChange={handleFileChange} className="mt-1" />

          <div className="mt-4">
            <label className="block text-sm font-medium">Or paste text</label>
            <textarea value={rawText} onChange={handlePasteTextChange} rows={8} className="mt-1 w-full border rounded p-2" placeholder="Paste up to 15 pages of text here..."></textarea>
            <div className="text-xs text-gray-500 mt-1">Approx pages: {pages} • File: {filename || 'none'}</div>
          </div>

          <div className="mt-4 border-t pt-4">
            <label className="inline-flex items-center">
              <input type="checkbox" checked={loveMsgEnabled} onChange={(e) => setLoveMsgEnabled(e.target.checked)} className="mr-2" />
              <span className="text-sm">Include a gentle love message/context for your girlfriend (editable)</span>
            </label>
            {loveMsgEnabled && (
              <textarea value={loveMsg} onChange={(e) => setLoveMsg(e.target.value)} rows={4} className="mt-2 w-full border rounded p-2" />
            )}
          </div>

        </div>

        <div className="md:col-span-2">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium">Prompt (tell the AI EXACTLY what to do)</label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} className="mt-1 w-full border rounded p-2" placeholder={`Example: "Edit the document for clarity and grammar. Return only the edited text (no annotations). Keep paragraphs intact."`} />

              <div className="flex items-center gap-3 mt-3">
                <label className="text-sm">Model</label>
                <select value={model} onChange={(e) => setModel(e.target.value)} className="border rounded p-1">
                  <option value="gpt-4o-mini">gpt-4o-mini</option>
                  <option value="gpt-4o">gpt-4o</option>
                  <option value="gpt-4o-mini-vision">gpt-4o-mini-vision</option>
                </select>

                <button onClick={handleRun} disabled={loading} className="ml-auto bg-blue-600 text-white px-4 py-2 rounded hover:opacity-95">{loading ? 'Running…' : 'Run AI'}</button>
                <button onClick={handleClear} className="ml-2 bg-gray-200 px-3 py-2 rounded">Clear</button>
              </div>

              {error && <div className="mt-3 text-red-600">{error}</div>}

              <div className="mt-6">
                <h3 className="font-semibold">AI Output</h3>
                <div className="mt-2 whitespace-pre-wrap border rounded p-4 min-h-[160px] bg-gray-50">{responseText || <span className="text-gray-400">AI output will appear here (only what you asked for).</span>}</div>
                {responseText && (
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => { navigator.clipboard.writeText(responseText); }} className="px-3 py-2 bg-green-600 text-white rounded">Copy</button>
                    <a download={`edited-${filename || 'text'}.txt`} href={`data:text/plain;charset=utf-8,${encodeURIComponent(responseText)}`} className="px-3 py-2 bg-indigo-600 text-white rounded">Download</a>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h3 className="font-semibold">Guidelines / Tips</h3>
              <ul className="list-disc ml-5 mt-2 text-sm text-gray-700">
                <li>Make the prompt specific. Example: "Return only corrected text with British English spelling. Keep sentence length similar."</li>
                <li>Use the love message to give the assistant a tone to follow when editing (optional).</li>
                <li>Keep uploads ≤ 15 pages. If you need more, split into multiple uploads and run sequentially.</li>
                <li>For production, move the OpenAI key to a server-side component to avoid exposing it in the browser.</li>
              </ul>

              <h4 className="mt-4 font-medium">Privacy & Cost</h4>
              <p className="text-sm text-gray-600">You must provide your OpenAI API key. Calls to OpenAI are billed to the key's owner — they are not free. This app doesn't store your key or documents (unless you implement backend storage).</p>

              <h4 className="mt-4 font-medium">Quick Example Prompt</h4>
              <pre className="mt-2 bg-gray-100 p-3 rounded text-sm">Edit for grammar & clarity. Return only the edited text. Preserve paragraphs and tone. Do not add any commentary.</pre>
            </div>
          </div>
        </div>

      </div>

      <footer className="max-w-6xl mx-auto mt-6 text-center text-xs text-gray-500">AuthorMate — demo — provide your own API key. Built with care ❤️</footer>
    </div>
  );
}
