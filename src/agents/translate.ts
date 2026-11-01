/**
 * The micro-task Agent B sells: a tiny deterministic EN->ES word translator. It stands in for any
 * Execution-Market-style task; what matters for the demo is that the delivered bytes are hashed into the receipt.
 */
const DICT: Record<string, string> = {
  hello: 'hola', world: 'mundo', agent: 'agente', agents: 'agentes', pay: 'pagan', pays: 'paga', paid: 'pagado',
  payment: 'pago', task: 'tarea', receipt: 'recibo', chain: 'cadena', the: 'el', a: 'un', and: 'y', for: 'para',
  hire: 'contratar', hires: 'contrata', other: 'otro', each: 'cada', good: 'buen', morning: 'día', thanks: 'gracias',
  thank: 'gracias', you: 'tú', is: 'es', are: 'son', on: 'en', in: 'en', with: 'con', money: 'dinero', fast: 'rápido',
  translate: 'traducir', this: 'esto', settle: 'liquidar', settled: 'liquidado', verify: 'verificar',
};

export const MAX_TEXT_LENGTH = 280;

export function translateEnEs(text: string): string {
  return text.replace(/[A-Za-z]+/g, (w) => {
    const t = DICT[w.toLowerCase()];
    if (!t) return w;
    return w[0] === w[0]!.toUpperCase() ? t[0]!.toUpperCase() + t.slice(1) : t;
  });
}
