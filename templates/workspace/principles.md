# Team Principles

## 1. Write it down
Don't decide verbally. Even a short note counts.
A decision not written down becomes "what did we say again?" later.

## 2. Record the why
Not just "we chose A" but "B was an option too, but we went with A because X."
So when conditions change, we can re-evaluate.

## 3. Make it findable
Writing is only half the battle — being able to find it later matters just as much.
Clear titles, consistent locations.

## 4. Start small
Don't try to write the perfect SOP.
A one-paragraph memo is 100x better than nothing.

## 5. Revisit
Writing it down isn't the end. Once a month,
just ask: "is this still right?"

## 6. Put it in the right place
Records have a home. In the wrong place, it's the same as lost.

| This kind of record | Goes here | Example |
|---------------------|-----------|---------|
| Work log — what you did and learned today | `.project/progress.md` | "Narrowed ETF screening to PER < 20" |
| A decision for this project | `.project/decisions/` | "Switched data source from Bloomberg to Yahoo" |
| A decision affecting multiple projects | `workspace/decisions/` | "All client proposals written in Korean" |
| Project context for AI | `AGENTS.md` | Auto-generated — synthesized from progress & decisions |

**Rule of thumb**: "Does this decision affect other projects too?"
- Yes → `workspace/decisions/`
- No → `.project/decisions/`
- Not sure → `.project/decisions/` (can move later)
