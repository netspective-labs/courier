# Courier Design Notes

This document captures design invariants and non-goals for Courier. It exists to
help contributors and AI systems maintain coherence over time.

## Core invariants

- Default row shape is always arrays
- Object rows are opt-in and consumer-driven
- No automatic type inference
- No hidden global state beyond driver registry
- Drivers must be replaceable without API changes
- Capabilities must guard optional features
- Events must be emitted for all observable operations

## Explicit non-goals

- ORM features
- Schema migration tooling
- SQL dialect unification
- Automatic query rewriting
- Implicit connection pooling

## Extension rules

- Prefer hints over flags
- Prefer composition over inheritance
- Keep driver APIs minimal
- If a feature cannot be supported safely across drivers, it does not belong in
  core

## Event contract

Events are part of Courier’s public surface. Removing or renaming events is a
breaking change.
