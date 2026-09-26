"""Find local Go and Java file relationships without executing repository code."""
import json
import os
import re
import sys
import tree_sitter
import tree_sitter_go
import tree_sitter_java


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def scan(root, files, language):
    grammar = tree_sitter_go if language == "go" else tree_sitter_java
    parser = tree_sitter.Parser(tree_sitter.Language(grammar.language()))
    trees = {}
    for file in files:
        with open(os.path.join(root, file), "rb") as stream:
            source = stream.read()
        trees[file] = (source, parser.parse(source).root_node)
    edges = set()
    if language == "go":
        packages = {}
        modules = {}
        for file, (source, tree) in trees.items():
            directory = os.path.dirname(file)
            parent = directory
            while True:
                if parent not in modules:
                    try:
                        with open(os.path.join(root, parent, "go.mod"), encoding="utf-8") as stream:
                            match = re.search(r'^\s*module\s+(?:"([^"]+)"|(\S+))', stream.read(), re.M)
                            modules[parent] = (match.group(1) or match.group(2)) if match else None
                    except OSError:
                        modules[parent] = None
                if modules[parent]:
                    suffix = os.path.relpath(directory or ".", parent or ".").replace("\\", "/")
                    package = modules[parent] + ("/" + suffix if suffix != "." else "")
                    if not file.endswith("_test.go"):
                        packages.setdefault(package, []).append(file)
                    break
                if not parent:
                    break
                parent = os.path.dirname(parent)
        for file, (source, tree) in trees.items():
            for node in walk(tree):
                if node.type != "import_spec":
                    continue
                literal = node.child_by_field_name("path")
                if literal is None:
                    continue
                raw = source[literal.start_byte:literal.end_byte].decode("utf-8")
                try:
                    package = raw[1:-1] if raw.startswith("`") else json.loads(raw)
                except ValueError:
                    continue
                for target in packages.get(package, []):
                    if target != file:
                        edges.add((file, target))
    else:
        types = {}
        packages = {}
        for file, (source, tree) in trees.items():
            package = ""
            for node in tree.children:
                if node.type == "package_declaration":
                    name = next((child for child in node.named_children if child.type in ("identifier", "scoped_identifier")), None)
                    if name:
                        package = source[name.start_byte:name.end_byte].decode("utf-8")
            packages.setdefault(package, []).append(file)
            for node in tree.children:
                if node.type in ("class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"):
                    name = node.child_by_field_name("name")
                    if name:
                        qualified = (package + "." if package else "") + source[name.start_byte:name.end_byte].decode("utf-8")
                        types.setdefault(qualified, []).append(file)
        for file, (source, tree) in trees.items():
            for node in tree.children:
                if node.type != "import_declaration":
                    continue
                name = next((child for child in node.named_children if child.type in ("identifier", "scoped_identifier")), None)
                if name is None:
                    continue
                qualified = source[name.start_byte:name.end_byte].decode("utf-8")
                wildcard = any(child.type == "asterisk" for child in node.children)
                static = any(child.type == "static" for child in node.children)
                targets = packages.get(qualified, []) if wildcard and not static else []
                while qualified:
                    targets = targets + types.get(qualified, [])
                    qualified = qualified.rpartition(".")[0]
                for target in targets:
                    if target != file:
                        edges.add((file, target))
    return {"ok": True, "edges": [{"source": source, "target": target} for source, target in sorted(edges)]}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(scan(request["root"], request["files"], request["language"])))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
