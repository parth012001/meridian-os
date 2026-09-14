# Technical Case Study: Build an Autonomous Organization (verbatim, received 2026-09-14)

## Background
Enterprise software is moving toward autonomous organizations: systems of goal-seeking agents that pursue business outcomes across time, modalities, data, and applications. Instead of waiting for a person to execute every step, these systems observe the state of a business, plan, act, learn from results, and involve people when judgment or approval is required.

An autonomous organization still needs human control. People define its goals, constraints, permissions, and escalation paths. The technical challenge is building an operating system that can represent the business, coordinate agents, improve safely, and make every action understandable and accountable.

## The case study
Design and build a prototype of an autonomous organization whose primary business is [distributing commercial and residential doors, frames, and hardware]. The company buys from manufacturers and sells to contractors, builders, dealers, and facility managers. Its work includes quoting, product configuration, pricing, purchasing, inventory, order management, delivery, customer communication, invoicing, and returns.

Choose one meaningful business outcome for the organization to pursue. Examples include increasing quote conversion while protecting margin, delivering orders on time despite supply constraints, reducing working capital, or identifying and recovering at-risk orders. Define the desired outcome, how you measure success, and the constraints within which the system may act.

## Questions to consider
- What does an autonomous organization even mean?
- How should the desired outcome, current business state, constraints, and measures of success be represented declaratively?
- How important is an ontology or graph representation? What entities, relationships, events, and rules must the system understand up front? When should we rely on the model's innate understanding?
- How will agents plan and act across different time horizons and modalities while maintaining shared state?
- How can outcomes, feedback, and failures create a self-improving loop without introducing regressions?
- How should identity, permissions, approvals, data access, and auditability work when agents take consequential actions?

## What to build
You will build a software application that allows an enterprise customer to build, govern, manage, and scale an autonomous organization. Include one or two working agents that complete a meaningful multi-step workflow.

## How we will evaluate the work
- Prioritization: Did you identify the most important problem, cut scope intelligently, and reach a working result within four hours?
- Creativity: Do you have a specific and thoughtful view of how autonomous organizations should work?
- Applied AI quality: Are the agents goal-directed, grounded in business state, able to use tools, and robust enough to complete the workflow?
- Engineering quality: Does the architecture show strong data modeling, interfaces, state management, observability, failure handling, security, and permissioning?

## Deliverables and format
- Use any tools, languages, models, libraries, or agent frameworks.
- Spend no more than 4 hours designing and coding.
- Submit a GitHub repository with the working prototype, sample data, setup instructions, and your main assumptions and tradeoffs.
- We will use 60 to 90 minutes for the demonstration and debrief. Be prepared to explain what you prioritized, where the system will fail, and what you would build next.
- Questions: You may ask a reasonable number of questions during the assignment by text or phone.
