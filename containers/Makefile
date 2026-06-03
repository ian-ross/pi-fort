.PHONY: all pi-work pi-work-image

PI_WORK_IMAGE ?= pi-work:local

MAKEFILE_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
PROJECT_ROOT := $(abspath $(MAKEFILE_DIR))

all: pi-work

pi-work: pi-work-image
	gondolin build --config $(MAKEFILE_DIR)/gondolin-build-config.json --output $(MAKEFILE_DIR)/pi-work

pi-work-image: $(MAKEFILE_DIR)/Dockerfile.pi-work
	docker build -f $(MAKEFILE_DIR)/Dockerfile.pi-work -t $(PI_WORK_IMAGE) $(PROJECT_ROOT)
