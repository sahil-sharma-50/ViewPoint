# Last Rites

A controlled demolition simulator for software.

Last Rites is being built to help developers identify retirement candidates, inspect dependencies, rehearse supported code removals, and export a reviewable patch with reproducible evidence.

## Planned workflow

1. Select a GitHub repository and revision.
2. Explore retirement candidates on an interactive dependency map.
3. Preview affected code, shared dependencies, and unresolved references.
4. Rehearse a supported removal in an isolated environment.
5. Review the patch and compare build and test results with the original revision.

The initial scope is TypeScript repositories, with supported feature flags and declared entry points. Analysis and transformations use explicit rules and graph algorithms; the product requires no LLM at runtime. Unknown dynamic behavior and external consumers remain explicit limitations. Passing checks does not establish universal deletion safety.

## Status

Project setup only. The application is not implemented yet.

Development is planned with IBM Bob IDE for the IBM Bob 2.0 Hackathon. Relevant Bob task session summary screenshots will be included in `bob_sessions/` as development proceeds.

## License

MIT. See [LICENSE](LICENSE).
