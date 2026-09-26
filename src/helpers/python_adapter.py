"""Find local Python imports without importing repository code."""
import ast
import json
import os
import sys


def scan(root, files):
    modules = {}
    for file in files:
        key = file.removesuffix("/__init__.py").removesuffix(".py").replace("/", ".")
        modules[key] = file
    for file in files:
        key = file.removesuffix("/__init__.py").removesuffix(".py").replace("/", ".")
        parts = key.split(".")
        if "src" in parts:
            alias = ".".join(parts[parts.index("src") + 1:])
            if alias:
                modules[alias] = file if alias not in modules or modules[alias] == file else None
    edges = set()
    for file in files:
        try:
            with open(os.path.join(root, file), encoding="utf-8") as source:
                tree = ast.parse(source.read(), filename=file)
        except (SyntaxError, UnicodeError, OSError):
            continue
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                package = file.rsplit("/", 1)[0].replace("/", ".") if "/" in file else ""
                parts = package.split(".") if package else []
                if node.level > len(parts):
                    continue
                prefix = parts[:max(0, len(parts) - node.level + 1)] if node.level else []
                base = ".".join(prefix + ([node.module] if node.module else [])) if node.level else node.module or ""
                names = [base] + [base + "." + alias.name for alias in node.names]
            for name in names:
                target = modules.get(name)
                if target and target != file:
                    edges.add((file, target))
    return {"ok": True, "edges": [{"source": source, "target": target} for source, target in sorted(edges)]}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(scan(request["root"], request["files"])))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
