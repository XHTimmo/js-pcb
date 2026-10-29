'use strict';
const geometry = require('../geometry.js');

module.exports = function routeFixed(net, NodeSet, terminalLayers) {
	const pcb = net.m_pcb;
	net.sub_terminal_collision_lines();
	net.m_fixed.forEach((fixed) => net.fixed_collision(fixed, false));
	try {
		const items = [];
		for (const fixed of net.m_fixed)
			for (let i = 1; i < fixed.points.length; i++)
				items.push({
					fixed: true,
					a: fixed.points[i - 1],
					b: fixed.points[i],
					radius: fixed.radius,
					nodes: [fixed.points[i - 1], fixed.points[i]],
				});
		for (const terminal of net.m_terminals) {
			const layers = terminalLayers(terminal);
			if (!layers.length) {
				net.remove();
				return false;
			}
			items.push({ terminal, nodes: layers.map((z) => [terminal[2][0], terminal[2][1], z]) });
		}
		const components = geometry
			.groups(items, (a, b) => {
				if (a.fixed && b.fixed)
					return (
						Math.max(Math.min(a.a[2], a.b[2]), Math.min(b.a[2], b.b[2])) <=
							Math.min(Math.max(a.a[2], a.b[2]), Math.max(b.a[2], b.b[2])) &&
						geometry.segmentDistance(a.a, a.b, b.a, b.b) <= a.radius + b.radius + geometry.EPS
					);
				if (!a.fixed && b.fixed) [a, b] = [b, a];
				return (
					a.fixed &&
					b.terminal &&
					terminalLayers(b.terminal).some(
						(z) =>
							z >= Math.min(a.a[2], a.b[2]) &&
							z <= Math.max(a.a[2], a.b[2]) &&
							geometry.padDistance(a.a, a.b, b.terminal, z) <= a.radius + geometry.EPS,
					)
				);
			})
			.map((component) =>
				component
					.flatMap((item) => item.nodes)
					.map((point) => {
						const node = [Math.round(point[0]), Math.round(point[1]), point[2]];
						pcb.m_deform.set(node.toString(), point.slice());
						return node;
					}),
			);
		const visited = new NodeSet(components.shift() || [], pcb.m_node_key);
		for (const ends of components) {
			if (pcb.expired()) {
				pcb.m_timedout = true;
				net.remove();
				return false;
			}
			if (!ends.some((node) => visited.has(node))) {
				if (!pcb.mark_distances(pcb.m_routing_flood_vectors, net.m_radius, net.m_via, net.m_gap, visited, ends)) {
					pcb.m_timedout = true;
					pcb.unmark_distances();
					net.remove();
					return false;
				}
				const reachable = ends.filter((node) => pcb.get_node(node) > 0).sort((a, b) => pcb.get_node(a) - pcb.get_node(b));
				const result = reachable.length ? net.backtrack_path(visited, reachable[0], net.m_radius, net.m_via, net.m_gap) : [[], false];
				pcb.unmark_distances();
				if (!result[1]) {
					net.remove();
					return false;
				}
				net.m_paths.push(result[0]);
				for (const node of result[0]) visited.add(node);
			}
			for (const node of ends) visited.add(node);
		}
		net.m_paths = net.optimise_paths(net.m_paths);
		net.add_paths_collision_lines();
		net.add_terminal_collision_lines();
		net.m_routed = true;
		return true;
	} finally {
		net.m_fixed.forEach((fixed) => net.fixed_collision(fixed, true));
	}
};
