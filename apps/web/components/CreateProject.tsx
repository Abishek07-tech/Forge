"use client";

import { useState } from "react";
import { Project } from "../types/project";

interface CreateProjectProps {
  onProjectCreated: (project: Project) => void;
}

export default function CreateProject({
  onProjectCreated,
}: CreateProjectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    if (!name.trim() || isCreating) {
      return;
    }

    setIsCreating(true);

    const response = await fetch("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
      }),
    });

    const result = await response.json();

    console.log(result);

    setIsCreating(false);

    if (result.success) {
      onProjectCreated(result.data);
      setName("");
      setIsOpen(false);
    }
  }

  return (
    <div>
      <button onClick={() => setIsOpen(true)}>
        Create Project
      </button>

      {isOpen && (
        <div>
          <h3>Create Project</h3>

          <input
            type="text"
            placeholder="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          <button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? "Creating..." : "Create"}
          </button>
        </div>
      )}
    </div>
  );
}