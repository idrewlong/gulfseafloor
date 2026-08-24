package k8srequiredsecuritycontext

good := {
	"review": {"object": {
		"kind": "Deployment",
		"metadata": {"name": "gulf-viewer"},
		"spec": {"template": {"spec": {
			"hostNetwork": false,
			"securityContext": {
				"runAsNonRoot": true,
				"runAsUser": 65532,
				"seccompProfile": {"type": "RuntimeDefault"},
			},
			"containers": [{
				"name": "gulf-viewer",
				"securityContext": {
					"runAsNonRoot": true,
					"runAsUser": 65532,
					"allowPrivilegeEscalation": false,
					"readOnlyRootFilesystem": true,
					"capabilities": {"drop": ["ALL"]},
					"seccompProfile": {"type": "RuntimeDefault"},
				},
			}],
		}}},
	}},
}

bad := {
	"review": {"object": {
		"kind": "Deployment",
		"metadata": {"name": "wide-open"},
		"spec": {"template": {"spec": {
			"containers": [{"name": "web", "image": "nginx"}],
		}}},
	}},
}

test_compliant_allowed {
	count(violation) == 0 with input as good
}

test_noncompliant_denied {
	count(violation) > 0 with input as bad
}

test_noncompliant_mentions_run_as_non_root {
	v := violation[_] with input as bad
	contains(v.msg, "runAsNonRoot")
}
