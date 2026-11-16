import { Camera, Inbox, Kanban, MessageCircle, MessagesSquare, Phone, UserRound } from "lucide-react";

/** Sign-in surfaces: the brand colour owns the left half (big type, the three channels, what is inside), the form stays calm on white. Below lg the panel shrinks to a header. */
const CHANNELS = [
  { name: "Messenger", Icon: MessageCircle, bg: "bg-[#0B6EF0]" },
  { name: "Instagram", Icon: Camera, bg: "bg-[#C2307F]" },
  { name: "WhatsApp", Icon: Phone, bg: "bg-[#128C4A]" },
] as const;
const PILLARS = [
  { name: "Inbox", Icon: Inbox, text: "One thread per customer, with honest delivery status." },
  { name: "Leads", Icon: UserRound, text: "Turn a conversation into a deal." },
  { name: "Pipeline", Icon: Kanban, text: "See every deal by stage and move it forward." },
] as const;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(27.5rem,32.5rem)]">
      <aside aria-label="About Social CRM" className="relative flex flex-col overflow-hidden bg-accent px-6 pb-7 pt-6 text-on-accent lg:px-[clamp(2rem,5vw,4.5rem)] lg:pb-10 lg:pt-9">
        <span aria-hidden className="pointer-events-none absolute -right-36 -top-36 hidden size-[26rem] rounded-full border-[4rem] border-on-accent/10 lg:block" />
        <span className="relative inline-flex items-center gap-2.5 text-md font-bold tracking-title">
          <span className="inline-flex size-[30px] items-center justify-center rounded-[9px] bg-on-accent text-accent"><MessagesSquare className="size-4" aria-hidden /></span>
          Social CRM
        </span>
        <div className="relative mt-7 max-w-[38rem] lg:my-auto">
          <p className="text-[2rem] font-extrabold leading-[1.05] tracking-[-0.035em] lg:text-[clamp(2.75rem,5.2vw,4.25rem)] lg:leading-[1.02]">
            Every message<span aria-hidden className="-ml-[0.09em]">.</span><br />Every lead<span aria-hidden className="-ml-[0.09em]">.</span><br /><span className="text-[#C9C3FF]">One place<span aria-hidden className="-ml-[0.09em]">.</span></span>
          </p>
          <p className="mt-5 hidden max-w-[30rem] text-lg text-on-accent/90 lg:block">Answer customers on Messenger, Instagram and WhatsApp, and follow each one to a won deal, without switching apps.</p>
          <ul aria-label="Channels" className="mt-8 hidden flex-wrap gap-2.5 lg:flex">
            {CHANNELS.map(({ name, Icon, bg }) => (
              <li key={name} className="inline-flex items-center gap-2.5 rounded-full bg-surface py-2 pl-2.5 pr-4 text-base font-semibold text-fg">
                <span aria-hidden className={`inline-flex size-[26px] items-center justify-center rounded-full text-on-accent ${bg}`}><Icon className="size-3.5" /></span>{name}
              </li>
            ))}
          </ul>
        </div>
        <ul aria-label="What is inside" className="relative mt-auto hidden grid-cols-3 gap-6 border-t border-on-accent/30 pt-6 lg:grid">
          {PILLARS.map(({ name, Icon, text }) => (
            <li key={name}><p className="mb-1.5 flex items-center gap-2 text-base font-bold"><Icon className="size-4" aria-hidden />{name}</p><p className="text-base text-on-accent/90">{text}</p></li>
          ))}
        </ul>
      </aside>
      <main id="main" className="flex flex-col bg-surface px-6 py-8 sm:px-10 lg:px-14 lg:py-10">
        <div className="flex flex-1 items-center"><div className="mx-auto w-full max-w-[25rem]">{children}</div></div>
      </main>
    </div>
  );
}
