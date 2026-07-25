import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export const Route = createFileRoute('/')({ component: Home })

const INSTALL = 'pi install npm:pi-gui-extension'
const GITHUB = 'https://github.com/ankitchouhan1020/pi-gui-extension'
const SCREENSHOT = 'https://github.com/user-attachments/assets/e1da0c5c-fe19-445e-9f07-24625eeef5f9'

type Row = { name: string; detail: ReactNode }

const FEATURES: { group: string; rows: Row[] }[] = [
  {
    group: 'sessions & workspace',
    rows: [
      { name: 'Live attach', detail: <>run <code>/gui</code> inside pi and the current session opens in your browser</> },
      { name: 'Many chats', detail: 'open, resume, switch, and run multiple pi sessions from one workspace' },
      { name: 'Persistent history', detail: 'pi still owns the durable JSONL session files; the browser follows along' },
      { name: 'Local server', detail: <>HTTP and SSE stay bound to <code>127.0.0.1</code></> },
    ],
  },
  {
    group: 'review & steer',
    rows: [
      { name: 'Git changes', detail: 'review repository status and diffs beside the agent work that changed them' },
      { name: 'Tool streams', detail: 'watch messages, thinking, shell output, tool calls, errors, and turn status live' },
      { name: 'Composer controls', detail: 'paste images, send prompts, run bash shortcuts, and stop active turns' },
      { name: 'Skills & files', detail: 'browse and edit local skills or project files without leaving pi ownership' },
    ],
  },
  {
    group: 'the agent itself',
    rows: [
      { name: 'Your pi setup', detail: 'models, auth, tools, skills, extensions, and prompts come from pi' },
      { name: 'No duplicate config', detail: 'the browser does not reimplement provider settings or agent state' },
      { name: 'Small protocol', detail: 'browser actions use REST; ordered events arrive over resumable SSE' },
      { name: 'Local customization', detail: 'theme, density, sidebars, motion, and sounds load from trusted local config' },
    ],
  },
]

const START: Row[] = [
  { name: INSTALL, detail: 'install the extension into pi' },
  { name: '/gui', detail: 'attach the current live session and open the browser' },
  { name: '/gui <sessionId>', detail: 'open a session ID or session file path' },
  { name: '/gui open <sessionId> 4000', detail: 'use a custom local port' },
  { name: '/gui stop', detail: 'stop the local host' },
]

const FAQ: Row[] = [
  { name: 'Does it replace pi?', detail: 'No. pi-gui is the browser shell; pi remains the agent runtime.' },
  { name: 'Is it public?', detail: <>No. The server binds to <code>127.0.0.1</code> only.</> },
  { name: 'Does it collect data?', detail: "No telemetry or analytics. Your sessions stay in pi's local storage." },
  { name: 'Do I configure models twice?', detail: 'No. Provider auth, models, tools, and skills stay in pi.' },
  { name: 'Is this an IDE?', detail: 'No. It is a workspace for running, watching, and steering pi sessions.' },
]

function Home() {
  return (
    <main className="mx-auto flex max-w-[720px] flex-col gap-11 px-6 pt-[12vh] pb-[14vh] font-mono text-[14px] leading-[1.6]">
      <header className="flex flex-col gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-[0.02em]">
          <img src="/favicon.svg" alt="" width={48} height={48} className="block size-12 border border-zinc-600 bg-card [image-rendering:pixelated]" />
          pi-gui
        </h1>
        <p className="text-foreground/70">
          Turn pi sessions into a <span className="text-brand">local browser workspace</span>.
          <span aria-hidden className="ml-[5px] inline-block h-[1.05em] w-[7px] animate-caret rounded-[1px] bg-brand align-[-0.15em] motion-reduce:animate-none" />
        </p>
        <p className="mt-3.5 text-muted-foreground">
          A localhost browser workspace built around pi — chats, tools, git, files, and multiple sessions in one window.
          <br />Free, local-only, no telemetry, no second model config.
        </p>
      </header>

      <section className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <a className="button" href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          <a className="button" href={`${GITHUB}#readme`} target="_blank" rel="noreferrer">README</a>
        </div>
        <CopyCommand command={INSTALL} />
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <Pill>127.0.0.1 only</Pill>
          <Pill>REST + SSE</Pill>
          <Pill>no telemetry</Pill>
          <Pill>pi owns runtime</Pill>
        </div>
      </section>

      <figure className="m-0 flex flex-col gap-2">
        <img src={SCREENSHOT} alt="pi-gui browser workspace with chat, tools, git, and files" width={2940} height={1846} className="block w-full rounded-lg border border-border bg-card" />
        <figcaption className="text-[13px] text-muted-foreground">Sessions, chat, tool output, git, and files in one local browser workspace</figcaption>
      </figure>

      <section className="flex flex-col gap-3.5">
        <SectionHeading>Features</SectionHeading>
        <div className="flex flex-col gap-7">
          {FEATURES.map((section) => (
            <div key={section.group} className="flex flex-col gap-3">
              <h3 className="flex items-center gap-3 text-xs font-normal tracking-[0.04em] text-foreground/60 after:h-px after:flex-1 after:bg-border after:content-['']">{section.group}</h3>
              <Rows rows={section.rows} />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3.5">
        <SectionHeading>Start</SectionHeading>
        <Rows rows={START} />
      </section>

      <section className="flex flex-col gap-3.5">
        <SectionHeading>Configure</SectionHeading>
        <p className="text-muted-foreground">Create <code>~/.pi/agent/pi-gui/config.json</code>. Project overrides use <code>.pi/pi-gui/config.json</code> after pi trusts the project.</p>
        <pre><code>{`{
  "version": 1,
  "appearance": { "density": "compact" },
  "motion": { "intensity": "subtle" },
  "sound": { "enabled": true, "volume": 0.2 },
  "theme": { "accent": "#7c6cff", "radius": "10px" }
}`}</code></pre>
      </section>

      <section className="flex flex-col gap-3.5">
        <SectionHeading>FAQ</SectionHeading>
        <div className="flex flex-col gap-2">
          {FAQ.map((item) => (
            <details key={item.name} className="group border-b border-border">
              <summary className="flex cursor-pointer list-none items-baseline gap-2.5 py-2 text-foreground transition-colors hover:text-brand [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="flex-none text-muted-foreground before:content-['+'] group-open:before:content-['–']" />
                {item.name}
              </summary>
              <p className="mb-3 ml-5 text-muted-foreground">{item.detail}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="text-[13px] text-muted-foreground">
        Built for pi · <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a> · © 2026
      </footer>
    </main>
  )
}

function Rows({ rows }: { rows: Row[] }) {
  return <ul className="grid list-none gap-2 p-0">{rows.map((row) => <DefinitionRow key={row.name} {...row} />)}</ul>
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-[13px] font-normal tracking-[0.04em] text-muted-foreground">{children}</h2>
}

function DefinitionRow({ name, detail }: Row) {
  return (
    <li className="group grid grid-cols-[190px_1fr] items-baseline gap-4 max-[560px]:grid-cols-1 max-[560px]:gap-0.5">
      <span className="text-foreground transition-colors group-hover:text-brand">{name}</span>
      <span className="text-muted-foreground transition-colors group-hover:text-foreground">{detail}</span>
    </li>
  )
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-[6px] border border-border px-2 py-[3px]">{children}</span>
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const commandRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      const range = document.createRange()
      if (!commandRef.current) return
      range.selectNodeContents(commandRef.current)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }

  return (
    <div className="flex max-w-full items-stretch self-start overflow-hidden rounded-[9px] border border-border bg-card">
      <code ref={commandRef} className="overflow-x-auto px-4 py-[7px] whitespace-pre"><span className="text-muted-foreground">$ </span>{command}</code>
      <button type="button" onClick={copy} className="border-l border-border px-3 text-muted-foreground transition-colors hover:bg-brand/8 hover:text-brand">
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}
