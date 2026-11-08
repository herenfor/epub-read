// Synthetic EPUB pieces for the CFI tests. Kept type-free so the reference
// generator (Readest's pinned foliate-js epubcfi.js, run outside the repo) can
// import the exact same markup that the tests parse.

export const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:synthetic:er0101</dc:identifier><dc:title>CFI</dc:title></metadata>
  <manifest>
    <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref id="ref-c2" idref="c2"/>
  </spine>
</package>`;

export const CHAPTER_1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>一</title></head>
<body>
<h1 id="head-1">第一章</h1>
<p>开头文字<span>𠀀字😀</span>后面，重复词与重复词。</p>
<p class="x">第二段 <em>强调</em> 结尾。</p>
</body>
</html>`;

export const CHAPTER_2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>二</title><style>p{margin:0}</style></head>
<body>
<script>var skipped = "脚本";</script>
<p hidden="hidden">隐藏段落</p>
<aside epub:type="footnote"><p>脚注内容</p></aside>
<p id="p2">同一句话。中间的内容。同一句话。</p>
</body>
</html>`;
