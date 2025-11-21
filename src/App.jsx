import React, { useState, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

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

  function buildMessages(documentText, userPrompt) {
    const system = `You are a precise assistant for authors. Follow the user's instructions exactly and only. Do not add commentary or extra explanations. Return only what the user requested.`;

    return [
      { role: "system", content: system },
      {
        role: "user",
        content: `DOCUMENT:\n${documentText}\n\nUSER INSTRUCTION:\n${userPrompt}`,
      },
    ];
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
          Authorization: `Bearer ${apiKey}`,
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
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      console.error(e);
      setError(String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }

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

    const messages = buildMessages(rawText, prompt);
    const out = await callOpenAI(messages);
    if (out !== null) setResponseText(out);
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
          <h1 className="text-2xl font-bold">
            AuthorMate — Edit Assistant{" "}
            <span className="text-pink-500 text-sm ml-2">
              for my love… future bestselling author… Lilou 💗
            </span>
          </h1>

          <p className="mt-2 text-sm text-gray-600">
            Upload a PDF (≤15 pages) or paste text. Provide your OpenAI key below — it
            stays in your browser. This tool helps you edit exactly how you want.
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

          <label className="block mt-4 text-sm font-medium">
            Upload PDF or text file (≤ 15 pages)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,text/plain"
            onChange={handleFileChange}
            className="mt-1"
          />

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
              Approx pages: {pages} • File: {filename || "none"}
            </div>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium">Prompt (exactly what to do)</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={8}
            className="mt-1 w-full border rounded p-2"
            placeholder={`Example: "Edit the document for clarity and grammar. Return only the edited text (no annotations). Keep paragraphs intact."`}
          />

          <div className="flex items-center gap-3 mt-3">
            <label className="text-sm">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="border rounded p-1"
            >
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini-vision">gpt-4o-mini-vision</option>
            </select>

            <button
              onClick={handleRun}
              disabled={loading}
              className="ml-auto bg-blue-600 text-white px-4 py-2 rounded hover:opacity-95"
            >
              {loading ? "Running…" : "Run AI"}
            </button>
            <button onClick={handleClear} className="ml-2 bg-gray-200 px-3 py-2 rounded">
              Clear
            </button>
          </div>

          {error && <div className="mt-3 text-red-600">{error}</div>}

          <div className="mt-6">
            <h3 className="font-semibold">AI Output</h3>
            <div className="mt-2 whitespace-pre-wrap border rounded p-4 min-h-[160px] bg-gray-50">
              {responseText || (
                <span className="text-gray-400">AI output will appear here…</span>
              )}
            </div>

            {responseText && (
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(responseText)}
                  className="px-3 py-2 bg-green-600 text-white rounded"
                >
                  Copy
                </button>
                <a
                  download={`edited-${filename || "text"}.txt`}
                  href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                    responseText
                  )}`}
                  className="px-3 py-2 bg-indigo-600 text-white rounded"
                >
                  Download
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="max-w-6xl mx-auto mt-6 text-center text-xs text-gray-500">
        AuthorMate — built with care ❤️
      </footer>
    </div>
  );
}
