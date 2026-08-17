#let navy = rgb("15264a")
#let blue = rgb("2563eb")
#let cyan = rgb("22d3ee")
#let ink = rgb("182033")
#let muted = rgb("667085")
#let line-color = rgb("d6dfeb")
#let paper-blue = rgb("f4f7fb")
#let horizontalrule = line(length: 100%, stroke: 1pt + line-color)

#show terms.item: it => block(breakable: false, spacing: 7pt)[
  #text(weight: "semibold", fill: navy)[#it.term]
  #block(inset: (left: 1.2em, top: 2pt))[#it.description]
]

#set table(
  inset: (x: 9pt, y: 7.5pt),
  stroke: .55pt + line-color,
  fill: (x, y) => if y == 0 { rgb("e9f0fa") } else if calc.even(y) { rgb("f8fafc") },
)
#show table.cell.where(y: 0): set text(weight: "semibold", fill: navy)
#show heading.where(level: 1): it => block(above: 30pt, below: 26pt, breakable: false)[
  #grid(columns: (4pt, 1fr), column-gutter: 11pt,
    rect(width: 4pt, height: 26pt, radius: 2pt, fill: blue),
    text(font: "Pretendard", size: 21pt, weight: "bold", fill: navy)[#it]
  )
]
#show heading.where(level: 2): it => block(above: 24pt, below: 16pt, breakable: false)[
  #text(font: "Pretendard", size: 14pt, weight: "semibold", fill: rgb("24456f"))[#it]
]
#show raw.where(block: true): it => block(
  width: 100%, inset: (x: 12pt, y: 11pt), radius: 5pt,
  fill: rgb("f3f6fa"), stroke: .6pt + line-color, it,
)
#show quote.where(block: true): it => block(
  width: 100%, inset: (left: 15pt, right: 13pt, y: 10pt),
  radius: (right: 5pt), fill: rgb("eff6ff"),
  stroke: (left: 3pt + blue),
  text(fill: rgb("28415f"))[#it.body]
)
#show figure.caption: it => block(above: 7pt)[
  #set text(font: "Pretendard", size: 8.8pt, fill: muted)
  #it
]

#show figure.where(
  kind: table
): set figure.caption(position: $if(table-caption-position)$$table-caption-position$$else$top$endif$)

#show figure.where(
  kind: image
): set figure.caption(position: $if(figure-caption-position)$$figure-caption-position$$else$bottom$endif$)

$if(highlighting-definitions)$
// syntax highlighting functions from skylighting:
$highlighting-definitions$

$endif$
$if(template)$
#import "$template$": conf
$else$
$template.typst()$
$endif$

$if(smart)$
$else$
#set smartquote(enabled: false)

$endif$
$for(header-includes)$
$header-includes$

$endfor$
#let tower-report(conf, doc) = {
  set page(
    header: context if counter(page).get().first() > 1 {
      grid(
        columns: (1fr, auto),
        align: (left, right),
        text(font: "Pretendard", size: 8pt, weight: "medium", fill: muted)[$if(title)$$title$$else$DOCUMENT$endif$],
        text(font: "Pretendard", size: 8pt, fill: muted)[PUBLICATION PDF],
      )
      v(4pt)
      line(length: 100%, stroke: .45pt + line-color)
    },
    footer: context grid(
      columns: (1fr, auto),
      align: (left, right),
      text(font: "Pretendard", size: 8pt, fill: muted)[출판물 수준 Typst PDF],
      text(font: "Pretendard", size: 8pt, weight: "semibold", fill: navy)[#counter(page).display("01")],
    ),
  )
  set par(justify: false, leading: 0.94em, spacing: 1.25em)
  set text(font: ("Pretendard", "Noto Sans CJK KR"), fill: ink, tracking: 0em)
  show strong: set text(weight: "semibold", fill: navy)
  show link: set text(fill: blue)
  show list: set list(indent: 1.15em, body-indent: .55em, spacing: 6pt)
  show enum: set enum(indent: 1.25em, body-indent: .65em, spacing: 6pt)

  conf.with(
    font: ("Pretendard", "Noto Sans CJK KR"),
    fontsize: 10.3pt,
    linestretch: 1.18,
    margin: (x: 22mm, top: 24mm, bottom: 22mm),
    paper: "a4",
    lang: "ko",
    region: "KR",
  )(doc)
}

#show: doc => tower-report(conf, doc)
#show: doc => conf(
$if(title)$
  title: [$title$],
$endif$
$if(subtitle)$
  subtitle: [$subtitle$],
$endif$
$if(author)$
  authors: (
$for(author)$
$if(author.name)$
    ( name: [$author.name$],
      affiliation: [$author.affiliation$],
      email: [$author.email$] ),
$else$
    ( name: [$author$],
      affiliation: "",
      email: "" ),
$endif$
$endfor$
    ),
$endif$
$if(keywords)$
  keywords: ($for(keywords)$$keywords$$sep$,$endfor$),
$endif$
$if(date)$
  date: [$date$],
$endif$
  lang: "ko",
  region: "KR",
$if(abstract-title)$
  abstract-title: [$abstract-title$],
$endif$
$if(abstract)$
  abstract: [$abstract$],
$endif$
$if(thanks)$
  thanks: [$thanks$],
$endif$
  margin: (x: 22mm, top: 25mm, bottom: 24mm),
  paper: "a4",
  font: ("Noto Sans CJK KR", "DejaVu Sans"),
$if(fontsize)$
  fontsize: $fontsize$,
$endif$
$if(mathfont)$
  mathfont: ($for(mathfont)$"$mathfont$",$endfor$),
$endif$
  codefont: ("DejaVu Sans Mono", "Noto Sans Mono CJK KR"),
$if(linestretch)$
  linestretch: $linestretch$,
$endif$
  sectionnumbering: "1.1",
  pagenumbering: $if(page-numbering)$"$page-numbering$"$else$none$endif$,
$if(linkcolor)$
  linkcolor: [$linkcolor$],
$endif$
$if(citecolor)$
  citecolor: [$citecolor$],
$endif$
$if(filecolor)$
  filecolor: [$filecolor$],
$endif$
  cols: $if(columns)$$columns$$else$1$endif$,
  doc,
)

$for(include-before)$
$include-before$

$endfor$
$if(toc)$
#outline(
  title: auto,
  depth: $toc-depth$
);
$endif$

$body$

$if(citations)$
$for(nocite-ids)$
#cite(label("${it}"), form: none)
$endfor$
$if(csl)$

#set bibliography(style: "$csl$")
$elseif(bibliographystyle)$

#set bibliography(style: "$bibliographystyle$")
$endif$
$if(bibliography)$

#bibliography(($for(bibliography)$"$bibliography$"$sep$,$endfor$)$if(full-bibliography)$, full: true$endif$)
$endif$
$endif$
$for(include-after)$

$include-after$
$endfor$
