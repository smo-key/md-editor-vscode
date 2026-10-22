# GFM feature tour

## Setext heading

Text with **bold**, *italic*, ***both***, ~~strikethrough~~, ~~single tilde~~, `inline code` and a hard\
line break.

## Links

Autolinks: <https://github.com>, [www.example.com](http://www.example.com), <https://commonmark.org> and <mail@example.com>.
An [inline link](https://example.com "Title"), a [reference link](https://example.com/ref) and an image:

![Alt text](https://example.com/image.png "Image title")

## Lists

- Bullet one
- Bullet two
  - Nested bullet
    1. Nested ordered

1. First
   - Nested bullet
2. Second
   1. Sub-second
      - [ ] Nested checkbox

- [ ] Open task
- [x] Done task
  - [ ] Nested task

## Table

| Left      | Center | Right |
| :-------- | :----: | ----: |
| a         |  **b** |   `c` |
| d \| pipe |    e   |     f |

## Code

```ts
const answer: number = 42;
```

```
tilde fence
```

```
  indented code
```

## Quotes and alerts

> A plain quote
>
> > nested quote

> [!TIP]
> Helpful advice.

> [!WARNING]
> Careful now.

## Footnotes

A claim with a footnote.[^1] And another.[^note]

[^1]: The first footnote.

[^note]: A named footnote.

## HTML

<details>
<summary>Click to expand</summary>

Hidden content.

</details>

Inline <kbd>Ctrl</kbd> and <sub>sub</sub> HTML.

***

Escaped \*not emphasis\* and # not heading.
