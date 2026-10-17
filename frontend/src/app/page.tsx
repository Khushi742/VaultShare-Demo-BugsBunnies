import UploadPanel from "@/components/upload-panel";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-violet-500/15 text-xl text-violet-300">
          ◈
        </div>
        <div>
          <p className="text-lg font-semibold tracking-tight">VaultShare</p>
          <p className="text-xs text-zinc-500">Private by design</p>
        </div>
        <span className="ml-auto rounded-full border border-emerald-400/20 px-3 py-1 text-xs text-emerald-300">
          End-to-end encrypted
        </span>
      </header>

      <section className="mx-auto my-auto w-full max-w-2xl py-16">
        <div className="mb-8 text-center">
          <p className="mb-3 text-sm font-medium tracking-[0.2em] text-violet-300 uppercase">
            Your files stay yours
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Send files, <span className="text-violet-300">not secrets.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-zinc-400">
            Files are encrypted in your browser and sent directly to the
            recipient. Your encryption key is never sent to our server.
          </p>
        </div>
        <UploadPanel />
        <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-zinc-500">
          <span>✦ AES-GCM encryption</span>
          <span>✦ Links expire in 5 minutes</span>
          <span>✦ No files stored on server</span>
        </div>
      </section>
      <footer className="text-center text-xs text-zinc-600">
        Share the link and its encryption key together; anyone with the link can
        access the file.
      </footer>
    </main>
  );
}
